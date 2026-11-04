import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startDevices, ADMIN_URL_ENV, ADMIN_TOKEN_ENV } from '../src/devices.js';

it('serves generated media with transfer path policy, requiring authentication and denying traversal or links', async () => {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-download-'));
  const hub = await startDevices(
    loadConfig(undefined, {
      SWIFTNEST_HOME: home,
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
    }),
  );
  try {
    await mkdir(join(home, 'files/media'));
    await writeFile(join(home, 'files/media/chart.png'), 'image bytes');
    await writeFile(join(home, 'secret.png'), 'private');
    await symlink(join(home, 'secret.png'), join(home, 'files/media/escape.png'));
    const url = (path: string) =>
      `${hub.env[ADMIN_URL_ENV]}/swiftnest/api/devices/files?${new URLSearchParams({ path })}`;
    expect((await fetch(url('media/chart.png'))).status).toBe(401);
    const headers = { authorization: `Bearer ${hub.env[ADMIN_TOKEN_ENV]}` };
    const response = await fetch(url('media/chart.png'), { headers });
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('image bytes');
    await writeFile(join(home, 'files/media/animation.gif'), 'GIF89a');
    const animation = await fetch(url('media/animation.gif'), { headers });
    expect(animation.headers.get('content-type')).toBe('image/gif');
    expect(await animation.text()).toBe('GIF89a');
    for (const path of ['../secret.png', 'media/escape.png', 'media', '', 'media/missing.png']) {
      expect((await fetch(url(path), { headers })).status).toBe(404);
    }
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});
