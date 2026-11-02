import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Perch } from '@swiftnest/core';
import { runLanPerch } from '@swiftnest/link-lan';
import files from '@swiftnest/cap-files';
import { loadConfig } from '../src/config.js';
import { startDevices, ADMIN_TOKEN_ENV, ADMIN_URL_ENV, MCP_TOKEN_ENV } from '../src/devices.js';
import { startKernel } from '../src/kernel.js';
import { devicesMcpPatch } from '../src/profile.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-hub-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const config = loadConfig(undefined, { SWIFTNEST_HOME: home, SWIFTNEST_DEVICES_PORT: '0', SWIFTNEST_DEVICES_MDNS: 'false' });
  const hub = await startDevices(config);
  cleanup.push(hub.close);
  const api = (path = '', method = 'GET', auth = hub.env[ADMIN_TOKEN_ENV]) => fetch(`${hub.env[ADMIN_URL_ENV]}/swiftnest/api/devices${path}`, { method, headers: { authorization: `Bearer ${auth}` } });
  return { home, config, hub, api };
}

describe('server device hub', () => {
  it('requires separate credentials and never persists per-process secrets', async () => {
    const { home, hub, api } = await setup();
    expect((await api('', 'GET', 'bad')).status).toBe(401);
    expect((await api('', 'GET', hub.env[MCP_TOKEN_ENV])).status).toBe(401);
    expect((await fetch(hub.mcpUrl, { method: 'POST' })).status).toBe(401);
    expect((await fetch(hub.mcpUrl, { headers: { authorization: `Bearer ${hub.env[ADMIN_TOKEN_ENV]}` } })).status).toBe(401);
    expect(await (await api()).json()).toEqual([]);
    const pairing = await (await api('/pairing', 'POST')).json();
    expect(pairing).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), url: hub.lanUrl, fingerprint: hub.nest.identity.fingerprint });
    expect(new Date(pairing.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await api('/audit?limit=-1')).status).toBe(400);
    expect((await api('/approve', 'POST')).status).toBe(404);
    expect(devicesMcpPatch(hub.mcpUrl)).toContain('!!js');
    expect(devicesMcpPatch(hub.mcpUrl)).not.toContain(hub.env[MCP_TOKEN_ENV]);
    expect((await readFile(join(home, 'devices/identity.pem'), 'utf8'))).toContain('PRIVATE KEY');
  });

  it('cleans up listeners when the kernel cannot spawn', async () => {
    const { hub, config } = await setup();
    config.devices.port = Number(new URL(hub.lanUrl).port);
    await hub.close();
    await expect(startKernel(config, { node: '/missing-swiftnest-node', readyTimeoutMs: 1000 })).rejects.toThrow('ENOENT');
    const reopened = await startDevices(config); cleanup.push(reopened.close);
    expect(reopened.lanUrl).toBe(hub.lanUrl);
  });

  it('pairs with fingerprint confirmation, approves/denies raw calls, pushes changes, persists and revokes', async () => {
    const { home, hub, config, api } = await setup();
    const events = await api('/events');
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('devices-changed');
    cleanup.push(async () => reader.cancel());
    const pairing = await (await api('/pairing', 'POST')).json();
    const perch = await new Perch({ device: 'test' }).use(files, { roots: [home] });
    cleanup.push(() => perch.close());
    const run = runLanPerch(perch, { url: pairing.url, reconnect: false, pairing: { code: pairing.code, confirm: async () => true } });
    cleanup.push(async () => { run.stop(); await run.finished; });
    await expect.poll(() => hub.nest.pairing.pending().length).toBe(1);
    expect(hub.nest.devices()).toHaveLength(0);
    const candidate = (await (await api('/pairing')).json())[0];
    expect(candidate.fingerprint).toBe(perch.identity.fingerprint);
    expect((await api(`/pairing/${candidate.id}/approve`, 'POST')).status).toBe(200);
    await expect.poll(() => hub.nest.devices().length).toBe(1);
    const args = { path: join(home, 'hello'), content: 'approved content' };
    const task = await hub.nest.call('test__files__write', args, { id: 'test-client', name: 'Test requester' });
    const pending = await (await api('/approvals')).json();
    expect(pending).toMatchObject([{ id: task.id, risk: 'write', args, client: { id: 'test-client' }, reason: expect.any(String) }]);
    expect((await api(`/approvals/${task.id}/approve`, 'POST')).status).toBe(200);
    expect((await hub.nest.tasks.wait(task.id, 3000)).state).toBe('succeeded');
    expect(await readFile(args.path, 'utf8')).toBe(args.content);
    expect((await api(`/approvals/${task.id}/approve`, 'POST')).status).toBe(409);
    const denied = await hub.nest.call('test__files__write', { ...args, content: 'denied' }, { id: 'test-client' });
    expect((await api(`/approvals/${denied.id}/deny`, 'POST')).status).toBe(200);
    expect(hub.nest.tasks.get(denied.id)?.state).toBe('denied');
    expect(await readFile(args.path, 'utf8')).toBe(args.content);
    expect(await (await api('/audit')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: task.id, state: 'succeeded', args }), expect.objectContaining({ taskId: denied.id, state: 'denied' })]));
    const push = new TextDecoder().decode((await reader.read()).value);
    expect(push).toContain('pairing-changed');
    run.stop(); await run.finished;
    await expect.poll(() => hub.nest.devices().length).toBe(0);
    const offline = (await (await api()).json())[0];
    expect(offline).toMatchObject({ online: false, paired: true, device: 'test', via: 'lan', lastSeen: expect.any(String), capabilities: [expect.objectContaining({ id: 'files' })] });
    const key = hub.nest.identity.publicKey;
    await reader.cancel();
    await hub.close();
    const reopened = await startDevices(config); cleanup.push(reopened.close);
    expect(reopened.nest.identity.publicKey).toBe(key);
    expect(reopened.nest.devicesStore.list()).toHaveLength(1);
    const result = await fetch(`${reopened.env[ADMIN_URL_ENV]}/swiftnest/api/devices`, { headers: { authorization: `Bearer ${reopened.env[ADMIN_TOKEN_ENV]}` } });
    expect(await result.json()).toMatchObject([{ online: false, lastSeen: offline.lastSeen, capabilities: offline.capabilities }]);
    await reopened.nest.revoke('test');
    expect(reopened.nest.devicesStore.list()).toEqual([]);
  });
});
