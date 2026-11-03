import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { generateIdentity } from '@swiftnest/core';
import { NativePairings } from '../bundle/src/native-pairings-store';
import { loadConfig } from '../src/config';
import { startDevices, ADMIN_TOKEN_ENV, ADMIN_URL_ENV } from '../src/devices';

it('binds only to a confirmed fingerprint, and existing device revoke also kills all bound App credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-parent-'));
  const hub = await startDevices(
    loadConfig(undefined, { SWIFTNEST_HOME: home, SWIFTNEST_DEVICES_PORT: '0', SWIFTNEST_DEVICES_MDNS: 'false' }),
  );
  const request = (path: string, body = {}, token = hub.env[ADMIN_TOKEN_ENV]) =>
    fetch(`${hub.env[ADMIN_URL_ENV]}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const identity = generateIdentity();
    await hub.nest.devicesStore.add({
      device: 'phone',
      publicKey: identity.publicKey,
      pairedAt: new Date().toISOString(),
    });
    const issue = () =>
      request('/swiftnest/control/native/issue', {
        audience: 'http://server',
        grant: { principal: { kind: 'owner' }, interactions: 'none' },
      });
    expect((await request('/swiftnest/control/native/issue', {}, 'bad')).status).toBe(401);
    expect(
      (
        await request('/swiftnest/control/native/issue', {
          audience: 'http://server',
          grant: { principal: { kind: 'device' }, interactions: 'answer' },
        })
      ).status,
    ).toBe(403);
    const { credential } = await (await issue()).json();
    const common = { audience: 'http://server', credential, device: 'phone' };
    expect((await request('/swiftnest/control/native/bind', { ...common, fingerprint: 'wrong' })).status).toBe(403);
    expect(
      (await request('/swiftnest/control/native/bind', { ...common, fingerprint: identity.fingerprint })).status,
    ).toBe(200);
    const store = new NativePairings(join(home, 'native-pairings.json'));
    expect(store.verify(credential, 'http://server')).toMatchObject({
      device: 'phone',
      fingerprint: identity.fingerprint,
      interactions: 'none',
    });
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    // The underlying existing Nest unpair/revoke path triggers credential invalidation, too.
    expect(await hub.nest.revoke('phone')).toBe(true);
    expect(store.verify(credential, 'http://server')).toBeUndefined();
    expect((await request('/swiftnest/control/native/resume', common)).status).toBe(401);
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});
