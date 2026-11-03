import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, chmod, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import {
  EncryptedChannel,
  channelPublicKey,
  generateChannelIdentity,
  channelRoute,
  appMuxFrame,
  encodeBytes,
  MAX_MESSAGE,
  type ChannelPairing,
} from '@swiftnest/channel';
import { appChannel } from '../src/channel';
import { loadChannelIdentity } from '../src/channel-identity';
import { AppChannel, pairingChannel } from '../../../packages/api/src/channel';
import { pairingUrl } from '../../src/pairing';

async function pair() {
  const identity = await generateChannelIdentity();
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const incoming = once(wss, 'connection');
  const clientWire = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
  const [serverWire] = (await incoming) as [WebSocket];
  const responder = EncryptedChannel.open(serverWire, identity, false);
  const initiator = EncryptedChannel.open(
    clientWire,
    await generateChannelIdentity(),
    true,
    channelPublicKey(identity),
  );
  const [server, client] = await Promise.all([responder, initiator]);
  return {
    server,
    client,
    serverWire,
    clientWire,
    async close() {
      client.close();
      server.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

describe('standard Noise App channel', () => {
  it('handshakes and exchanges encrypted messages in both directions without exposing chat text', async () => {
    const p = await pair();
    const sniffed: Buffer[] = [];
    p.serverWire.prependListener('message', (data) => sniffed.push(Buffer.from(new Uint8Array(data as ArrayBuffer))));
    p.clientWire.prependListener('message', (data) => sniffed.push(Buffer.from(new Uint8Array(data as ArrayBuffer))));
    try {
      p.client.send({ chat: 'PRIVATE LAN CHAT 你好' });
      expect(await p.server.next()).toEqual({ chat: 'PRIVATE LAN CHAT 你好' });
      p.server.send({ answer: 'PRIVATE LAN ANSWER' });
      expect(await p.client.next()).toEqual({ answer: 'PRIVATE LAN ANSWER' });
      expect(sniffed.length).toBeGreaterThan(1);
      expect(Buffer.concat(sniffed).includes(Buffer.from('PRIVATE LAN'))).toBe(false);
      expect(Buffer.concat(sniffed).includes(Buffer.from('你好'))).toBe(false);
    } finally {
      await p.close();
    }
  });
  it.each(['tamper', 'replay'])('closes on a %s frame', async (attack) => {
    const p = await pair();
    const original = p.clientWire.send.bind(p.clientWire);
    let captured: Uint8Array | undefined;
    p.clientWire.send = ((data: Uint8Array) => {
      captured = new Uint8Array(data);
      if (attack === 'tamper') captured[captured.length - 1] ^= 1;
      original(captured);
    }) as typeof p.clientWire.send;
    try {
      p.client.send({ private: 'secret' });
      if (attack === 'replay') {
        expect(await p.server.next()).toEqual({ private: 'secret' });
        original(captured!);
      }
      await expect(p.server.next()).rejects.toThrow();
    } finally {
      await p.close();
    }
  });
  it.each(['coalesced', 'fragmented'])('keeps consecutive records ordered with %s socket reads', async (shape) => {
    const p = await pair();
    const send = p.clientWire.send.bind(p.clientWire);
    const writes: Buffer[] = [];
    p.clientWire.send = ((data: Uint8Array) => writes.push(Buffer.from(data))) as typeof p.clientWire.send;
    try {
      for (let sequence = 0; sequence < 40; sequence++) p.client.send({ sequence });
      const bytes = Buffer.concat(writes);
      if (shape === 'coalesced') send(bytes);
      else for (let offset = 0; offset < bytes.length; offset += 17) send(bytes.subarray(offset, offset + 17));
      for (let sequence = 0; sequence < 40; sequence++) expect(await p.server.next()).toEqual({ sequence });
      p.server.send({ complete: true });
      expect(await p.client.next()).toEqual({ complete: true });
    } finally {
      await p.close();
    }
  });
  it('carries existing large live-view frames and rejects oversized application messages', async () => {
    const p = await pair();
    try {
      const frame = { t: 'message', binary: true, body: encodeBytes(new Uint8Array(4 * 1024 * 1024 + 46)) };
      p.server.send(frame);
      expect(await p.client.next()).toEqual(frame);
      expect(() => p.client.send('x'.repeat(MAX_MESSAGE))).toThrow('too large');
    } finally {
      await p.close();
    }
  });
  it('persists one identity with mode 0600 and refuses damaged identity files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'app-channel-key-'));
    try {
      const first = await loadChannelIdentity(home);
      const file = join(home, 'app-channel-key.json');
      await chmod(file, 0o644);
      expect(await loadChannelIdentity(home)).toEqual(first);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).toContain(first.signing);
      await writeFile(file, '{}');
      await expect(loadChannelIdentity(home)).rejects.toThrow('Cannot read channel identity');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('versions a QR-sized payload with addresses and preserves the legacy URL', async () => {
    const identity = await generateChannelIdentity();
    const payload: ChannelPairing = {
      v: 1,
      key: channelPublicKey(identity),
      addresses: { lan: ['http://192.168.1.5:3077/'], relay: [] },
    };
    const old = pairingUrl(payload.addresses.lan[0]!, 'TOKEN');
    expect(old).toBe('http://192.168.1.5:3077/connect?token=TOKEN&interactions=answer');
    const url = pairingUrl(payload.addresses.lan[0]!, 'TOKEN', payload);
    expect(url.length).toBeLessThan(500);
    expect(pairingChannel(new URL(url))).toEqual(payload);
    expect(pairingChannel(new URL(old))).toBeUndefined();
    expect(() => pairingChannel(new URL(`${old}#sn=broken`))).toThrow();
  });
  it('refuses a symlinked identity without changing the target permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'app-channel-symlink-'));
    try {
      const target = join(home, 'target');
      await writeFile(target, JSON.stringify(await generateChannelIdentity()), { mode: 0o644 });
      await symlink(target, join(home, 'app-channel-key.json'));
      await expect(loadChannelIdentity(home)).rejects.toThrow('identity file');
      expect((await stat(target)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('allows only App paths and rejects control, arbitrary RPCs, traversal and foreign targets', () => {
    for (const path of [
      '/swiftnest/control/devices/call',
      '/api/exec',
      '//elsewhere/api/session/list',
      '/swiftnest/api/devices/../../control/devices',
      '/swiftnest/api/devices/%2e%2e/preferences',
      '/app',
      '/connect',
    ])
      expect(channelRoute('POST', path)).toBe(false);
    expect(channelRoute('POST', '/api/session/create')).toBe(true);
    expect(channelRoute('WS', '/api/remote.mux')).toBe(true);
    expect(channelRoute('GET', '/swiftnest/api/devices/events')).toBe(true);
    expect(channelRoute('GET', '/api/session/create')).toBe(false);
    expect(channelRoute('DELETE', '/swiftnest/api/devices')).toBe(false);
    expect(channelRoute('WS', '/api/session/follow')).toBe(false);
    expect(channelRoute('GET', '/swiftnest/api/models')).toBe(true);
    expect(channelRoute('POST', '/swiftnest/api/models/keys/moonshotai-cn')).toBe(true);
    expect(channelRoute('POST', '/swiftnest/api/models/keys/../apply')).toBe(false);
    expect(channelRoute('POST', '/swiftnest/api/models/delete')).toBe(false);
  });
  it('permits only the App mux subscriptions, never arbitrary RPCs or binary uplinks', () => {
    for (const endpoint of ['$events', 'session/follow', 'userQuestions/attachWait'])
      expect(appMuxFrame(JSON.stringify({ type: 'open', streamId: '1', endpoint }))).toBe(true);
    expect(appMuxFrame('{"type":"cancel","streamId":"1"}')).toBe(true);
    expect(appMuxFrame('{"type":"open","streamId":"1","endpoint":"shell/run"}')).toBe(false);
    expect(appMuxFrame('{"type":"open","streamId":"1","endpoint":"session/follow"}', true)).toBe(false);
    expect(appMuxFrame('null')).toBe(false);
  });
});

it('pins the server before sending a credential; wrong and revoked credentials are refused inside Noise', async () => {
  const identity = await generateChannelIdentity();
  let credential = 'owner=GOOD';
  const localRequests: string[] = [];
  const http = createServer((req, res) => {
    localRequests.push(req.url!);
    if (req.url?.startsWith('/connect?token=PAIR'))
      res.writeHead(302, { 'set-cookie': `${credential}; HttpOnly` }).end();
    else if (req.url === '/?token=PAIR') res.writeHead(303, { 'set-cookie': `${credential}; HttpOnly` }).end();
    else if (req.headers.cookie !== credential) res.writeHead(401).end();
    else if (req.url === '/swiftnest/api/memory/topic?topic=empty') res.writeHead(204).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const root = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`);
  const bridge = appChannel(identity, () => root.origin, {
    admit: ({ headers }) =>
      headers.cookie === credential ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 },
  });
  http.on('upgrade', bridge.handler);
  const pin: ChannelPairing = { v: 1, key: channelPublicKey(identity), addresses: { lan: [root.href], relay: [] } };
  const options = { createWebSocket: (url: string) => new WebSocket(url) };
  let client: AppChannel | undefined;
  try {
    await expect(
      AppChannel.open(
        root,
        { ...pin, key: channelPublicKey(await generateChannelIdentity()) },
        options,
        { t: 'auth', cookie: credential },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: 'channel-key-mismatch' });
    expect(localRequests).toEqual([]);
    await expect(
      AppChannel.open(root, pin, options, { t: 'auth', cookie: 'owner=WRONG' }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: 'pairing-failed', httpStatus: 401 });
    client = await AppChannel.open(root, pin, options, { t: 'auth', token: 'PAIR' }, AbortSignal.timeout(1000));
    expect(client.cookie).toBe(credential);
    expect(await (await client.fetch(new URL('swiftnest/health', root), {}, credential)).json()).toEqual({ ok: true });
    const empty = await client.fetch(new URL('swiftnest/api/memory/topic?topic=empty', root), {}, credential);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
    expect(
      (await client.fetch(new URL('swiftnest/control/devices/call', root), { method: 'POST' }, credential)).status,
    ).toBe(404);
    const browser = await AppChannel.open(
      root,
      pin,
      options,
      { t: 'auth', token: 'PAIR', browser: true },
      AbortSignal.timeout(1000),
    );
    expect(browser.cookie).toBe(credential);
    browser.close();
    credential = 'owner=REVOKED';
    expect((await client.fetch(new URL('swiftnest/health', root), {}, client.cookie)).status).toBe(401);
    await expect(
      AppChannel.open(root, pin, options, { t: 'auth', cookie: client.cookie }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ httpStatus: 401 });
  } finally {
    client?.close();
    bridge.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
