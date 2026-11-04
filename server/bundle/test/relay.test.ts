import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import {
  EncryptedChannel,
  channelPublicKey,
  generateChannelIdentity,
  relayServerId,
  joinRelay,
  relaySocketUrl,
  type ChannelPairing,
} from '@swiftnest/channel';
import { startRelay } from '../../../packages/relay/src/index.js';
import { AppChannel } from '../../../packages/api/src/channel.js';
import { appChannel } from '../src/channel.js';
import { ServerRelay } from '../src/relay.js';

const secret = 's'.repeat(32);
it('prefers a reachable LAN, falls back to outbound relay, persists privately and can disable it', async () => {
  const relay = await startRelay({ port: 0, secret });
  const identity = await generateChannelIdentity();
  const home = await mkdtemp(join(tmpdir(), 'relay-unit-'));
  const http = createServer((_req, res) => res.end('{"ok":true}'));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const root = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`);
  const bridge = appChannel(identity, () => root.origin, { admit: () => ({ peer: { principal: { kind: 'owner' } } }) });
  http.on('upgrade', bridge.handler);
  const outbound = new ServerRelay(home, identity, bridge.accept);
  const clients: AppChannel[] = [];
  try {
    await outbound.save({ address: relay.url, secret });
    expect((await stat(join(home, 'relay.json'))).mode & 0o777).toBe(0o600);
    await expect.poll(() => outbound.connected).toBe(true);
    const pin = outbound.pairing(root.href);
    const dialed: string[] = [];
    const options = {
      createWebSocket: (url: string) => {
        dialed.push(url);
        return new WebSocket(url);
      },
      relaySecretStore: { load: async () => secret, save: async () => {} },
    };
    const lan = await AppChannel.preferred(
      root,
      pin,
      options,
      { t: 'auth', cookie: 'owner=secret' },
      AbortSignal.timeout(3000),
    );
    clients.push(lan);
    expect(lan.viaRelay).toBe(false);
    expect(dialed).toEqual([new URL('swiftnest/channel', root).href.replace('http:', 'ws:')]);
    const remote = await AppChannel.preferred(
      root,
      { ...pin, addresses: { ...pin.addresses, lan: ['http://127.0.0.1:1/'] } },
      options,
      { t: 'auth', cookie: 'owner=secret' },
      AbortSignal.timeout(3000),
    );
    clients.push(remote);
    expect(remote.viaRelay).toBe(true);
    expect(await (await remote.fetch(new URL('swiftnest/health', root), {}, 'owner=secret')).json()).toEqual({
      ok: true,
    });
    await expect(
      remote.fetch(new URL('swiftnest/api/devices/live', root), { method: 'POST' }, 'owner=secret'),
    ).rejects.toMatchObject({ code: 'relay-lan-only' });
    await outbound.load();
    expect(outbound.config).toEqual({ address: relay.url, secret });
    await outbound.save(null);
    await outbound.load({ address: relay.url, secret });
    expect(outbound.pairing(root.href).addresses.relay).toEqual([]);
  } finally {
    for (const client of clients) client.close();
    outbound.close();
    bridge.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await relay.close();
    await rm(home, { recursive: true, force: true });
  }
});
it('a malicious relay cannot substitute a different R1 server key or receive an App credential', async () => {
  const relay = await startRelay({ port: 0, secret });
  const expected = channelPublicKey(await generateChannelIdentity());
  const wrong = await generateChannelIdentity();
  const wire = new WebSocket(relaySocketUrl(relay.url));
  wire.on('error', () => {});
  const pin: ChannelPairing = { v: 1, key: expected, addresses: { lan: ['http://127.0.0.1:1/'], relay: [relay.url] } };
  const incoming = joinRelay(
    wire,
    { role: 'server', id: await relayServerId(expected), secret },
    AbortSignal.timeout(3000),
    undefined,
    () => EncryptedChannel.open(wire, wrong, false),
  )
    .then((channel) => channel.next())
    .catch(() => undefined);
  try {
    await expect(
      AppChannel.open(
        new URL(relay.url),
        pin,
        { createWebSocket: (url) => new WebSocket(url) },
        { t: 'auth', cookie: 'NEVER SENT' },
        AbortSignal.timeout(3000),
        secret,
      ),
    ).rejects.toMatchObject({ code: 'channel-key-mismatch' });
    expect(await incoming).toBeUndefined();
  } finally {
    wire.terminate();
    await relay.close();
  }
});
