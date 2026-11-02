import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Perch, memoryLink } from '@swiftnest/core';
import { startDevices, ADMIN_TOKEN_ENV, ADMIN_URL_ENV } from '../src/devices.js';
import { loadConfig } from '../src/config.js';
import { FileStorage } from '../src/file-storage.js';

it('pausing an approval cancels the task and stays paused after a server restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transfer-restart-'));
  const config = loadConfig(undefined, {
    SWIFTNEST_HOME: join(home, 'server'),
    SWIFTNEST_DEVICES_HOST: '127.0.0.1',
    SWIFTNEST_DEVICES_PORT: '0',
    SWIFTNEST_DEVICES_MDNS: 'false',
  });
  let hub = await startDevices(config);
  const perch = new Perch({ device: 'phone' });
  try {
    const root = join(home, 'phone');
    await mkdir(root);
    const storage = new FileStorage(root, join(home, 'receipts'), perch.identity.publicKey, 1024);
    perch.addCapability(storage.capability());
    await hub.nest.devicesStore.add({
      device: perch.device,
      publicKey: perch.identity.publicKey,
      pairedAt: new Date().toISOString(),
    });
    hub.nest.attach(memoryLink(perch));
    await writeFile(join(config.home, 'files', 'source'), 'small file');
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(hub.env[ADMIN_URL_ENV] + '/swiftnest/api/devices' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: 'Bearer ' + hub.env[ADMIN_TOKEN_ENV],
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const r = await api('/transfers', {
      source: { device: 'server', path: 'source' },
      destination: { device: 'phone', path: join(root, 'destination') },
    });
    await expect.poll(() => hub.nest.tasks.list({ state: 'pending_approval' }).length).toBe(1);
    const task = hub.nest.tasks.list({ state: 'pending_approval' })[0]!;
    expect(task.args).toMatchObject({
      binding: { meta: { size: 10 }, destination: perch.identity.publicKey },
    });
    expect((await api(`/transfers/${r.id}/pause`, {})).state).toBe('paused');
    expect(hub.nest.tasks.get(task.id)?.state).toBe('cancelled');
    await hub.close();
    hub = await startDevices(config);
    expect(await api('/transfers')).toMatchObject([{ id: r.id, state: 'paused', offset: 0 }]);
    expect(hub.nest.tasks.list()).toEqual([]);
    expect((await api(`/transfers/${r.id}/cancel`, {})).state).toBe('cancelled');
  } finally {
    await perch.close();
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});
