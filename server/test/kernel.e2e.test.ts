/**
 * Boots the real pinned DSH kernel on the swiftnest profile. Opt-in
 * (SWIFTNEST_E2E=1) because it needs the official Node build and takes a few
 * seconds; CI runs it in the server job.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { RunningKernel } from '../src/kernel.js';
import { startStableKernel } from './fixtures/kernel.js';
import { pairingUrl } from '../src/pairing.js';
import { connect } from '@swiftnest/api';
import WebSocket from 'ws';

const enabled = process.env.SWIFTNEST_E2E === '1';

describe.skipIf(!enabled)('Swiftnest Server kernel (e2e)', () => {
  let model: Server;
  let kernel: RunningKernel;
  let home: string;
  const lines: string[] = [];
  const tokens: string[] = [];

  beforeAll(async () => {
    model = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake' }] }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
    const modelPort = (model.address() as AddressInfo).port;
    home = mkdtempSync(join(tmpdir(), 'swiftnest-e2e-'));
    const dist = join(home, 'app');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html>App shell</html>');
    writeFileSync(join(dist, 'assets', 'app-12345678.js'), 'export {};');
    const config = loadConfig(undefined, {
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOME: home,
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_APP_DIST: dist,
      SWIFTNEST_PORT: '0',
      SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      SWIFTNEST_MODEL_ID: 'fake',
      SWIFTNEST_MEMORY_AUTO: 'false',
      SWIFTNEST_SEARCH: 'false',
    });
    kernel = await startStableKernel(config, {
      readyTimeoutMs: 90_000,
      onLine: (line) => lines.push(line),
      onReady: (running) => tokens.push(running.token),
    });
  }, 120_000);

  afterAll(async () => {
    await kernel?.stop();
    await new Promise((r) => model?.close(r));
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('redacts launch credentials before handing kernel output to log observers', () => {
    expect(lines.some((line) => line.includes('token=…'))).toBe(true);
    expect(tokens.some((token) => lines.some((line) => line.includes(token)))).toBe(false);
  });

  it('serves /swiftnest/health from the built-in module', async () => {
    const res = await fetch(new URL('swiftnest/health', kernel.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      swiftnest: '0.0.1',
      dsh: '0.2.1-rc.5',
      model: { configured: true, reachable: true },
    });
  });

  it("keeps DSH's native API behind authentication", async () => {
    expect((await fetch(new URL('api', kernel.url), { method: 'POST' })).status).toBe(401);
  });

  it('serves the public App and nested assets through real DSH prefix routing', async () => {
    expect(await (await fetch(new URL('app/', kernel.url))).text()).toBe('<html>App shell</html>');
    const asset = await fetch(new URL('app/assets/app-12345678.js', kernel.url));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await asset.text()).toBe('export {};');
    expect((await fetch(new URL('app/assets/missing.js', kernel.url))).status).toBe(404);
  });

  it('lets an App trade the launch token for an API session', async () => {
    const res = await fetch(pairingUrl(kernel.url, kernel.token, kernel.channelPairing), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('./api/remote.mux');
    expect(res.headers.get('set-cookie')).toBeTruthy();
  });

  it('carries App health and session requests inside the pinned channel', async () => {
    const client = await connect(pairingUrl(kernel.url, kernel.token, kernel.channelPairing), {
      fetch: async () => {
        throw new Error('Plain App HTTP is forbidden in this test');
      },
      createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
    });
    try {
      expect(await client.health()).toMatchObject({ ok: true });
      expect(await client.memoryAutoSettings()).toEqual({ enabled: false });
      expect(await client.chatSearchStatus()).toMatchObject({ settings: { enabled: false } });
      await expect(client.searchChats('test')).rejects.toMatchObject({ text: { key: 'chatSearchDisabled' } });
      const session = await client.createSession();
      expect(await client.listSessions()).toEqual(expect.arrayContaining([expect.objectContaining(session)]));
    } finally {
      client.close();
    }
  });

  it('serves the plugin page to the owner and keeps browser sessions across a plugin restart', async () => {
    // The web App signs in with the launch token at `/`; DSH keeps that cookie's signing key on disk.
    const signIn = await fetch(`${kernel.url}?token=${kernel.token}`, { redirect: 'manual' });
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const plugins = () => fetch(new URL('swiftnest/api/plugins', kernel.url), { headers: { cookie } });
    expect((await fetch(new URL('swiftnest/api/plugins', kernel.url))).status).toBe(401);
    const before = await plugins();
    expect(before.status).toBe(200);
    expect((await before.json()).apply).toEqual({ state: 'idle' });
    const { token } = kernel;
    const pin = kernel.channelPairing;
    await kernel.restart();
    expect(kernel.channelPairing).toEqual(pin);
    expect(kernel.token).not.toBe(token);
    expect(kernel.child.exitCode).toBeNull();
    expect((await plugins()).status).toBe(200);
  }, 120_000);
});
