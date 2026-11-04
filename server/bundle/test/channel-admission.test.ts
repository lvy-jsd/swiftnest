import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  clientAddress,
  generateChannelIdentity,
  channelPublicKey,
  HandshakeLimits,
  type ChannelPairing,
} from '@swiftnest/channel';
import { appChannel } from '../src/channel.js';
import { channelAddresses, normalizeChannelProxy } from '../src/trusted-proxy.js';
import { BrowserTickets } from '../src/browser-tickets.js';
import { AppChannel } from '../../../packages/api/src/channel.js';

afterEach(() => vi.unstubAllEnvs());
it('limits pending sockets and attempt rates per IP, with idempotent release and bounded state', () => {
  const limiter = new HandshakeLimits(1, 2, 2);
  const first = limiter.enter('one')!;
  expect(limiter.enter('one')).toBeUndefined();
  const other = limiter.enter('two')!;
  expect(limiter.enter('three')).toBeUndefined();
  first();
  first();
  const second = limiter.enter('one')!;
  second();
  other();
  expect(limiter.enter('one')).toBeUndefined();
});
it('only accepts an explicit TLS origin from the configured proxy IP; forwarded headers do not grant trust', () => {
  const request = (host = 'relay.example', origin = 'https://relay.example', ip = '127.0.0.1') =>
    ({
      headers: { host, origin, 'x-forwarded-host': 'evil.example' },
      socket: { remoteAddress: ip },
    }) as unknown as IncomingMessage;
  const target = new URL('http://127.0.0.1:3077');
  const env = { SWIFTNEST_TRUSTED_PROXY_IP: '127.0.0.1', SWIFTNEST_TRUSTED_PROXY_ORIGIN: 'https://relay.example' };
  const good = request();
  expect(normalizeChannelProxy(good, target, env)).toBe(true);
  expect(good.headers.host).toBe(target.host);
  expect(good.headers.origin).toBe(target.origin);
  expect(normalizeChannelProxy(request('evil.example'), target, env)).toBe(false);
  expect(normalizeChannelProxy(request('relay.example', 'https://evil.example'), target, env)).toBe(false);
  expect(normalizeChannelProxy(request('relay.example', undefined, '192.0.2.1'), target, env)).toBe(false);
  const direct = request(target.host, target.origin, '192.0.2.1');
  expect(normalizeChannelProxy(direct, target, env)).toBe(true);
  expect(normalizeChannelProxy(request(), target, {})).toBe(true);
  expect(normalizeChannelProxy(request(), target, { SWIFTNEST_TRUSTED_PROXY_IP: '127.0.0.1' })).toBe(false);
  expect(
    normalizeChannelProxy(request(), target, { ...env, SWIFTNEST_TRUSTED_PROXY_ORIGIN: 'http://relay.example' }),
  ).toBe(false);
  expect(channelAddresses(`${target.origin}/`, env)).toEqual(['https://relay.example/', `${target.origin}/`]);
});
it('ignores spoofed forwarded IPs unless the immediate proxy is trusted, and uses its rightmost valid IP', () => {
  const request = (forwarded: string) =>
    ({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: '127.0.0.1' } }) as IncomingMessage;
  expect(clientAddress(request('192.0.2.1'))).toBe('127.0.0.1');
  expect(clientAddress(request('192.0.2.1'), '192.0.2.2')).toBe('127.0.0.1');
  expect(clientAddress(request('spoof, 192.0.2.1'), '127.0.0.1')).toBe('192.0.2.1');
  expect(clientAddress(request('::1'), '127.0.0.1')).toBe('::1');
  for (const value of ['attacker', '192.0.2.1:80', '127.1', ''])
    expect(clientAddress(request(value), '127.0.0.1')).toBe('127.0.0.1');
});
it('expires browser tickets and releases stale per-IP budgets', () => {
  vi.useFakeTimers();
  try {
    const limits = new HandshakeLimits(1, 1, 1);
    limits.enter('one')!();
    expect(limits.enter('two')).toBeUndefined();
    vi.advanceTimersByTime(60000);
    expect(limits.enter('two')).toBeTypeOf('function');
    const tickets = new BrowserTickets();
    let body = '';
    const req = {
      method: 'POST',
      headers: { host: '127.0.0.1', cookie: 'owner=PRIVATE' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage;
    const res = {
      setHeader() {},
      writeHead() {
        return this;
      },
      end(value: string) {
        body = value;
      },
    };
    tickets.handler({ admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, () => 'http://127.0.0.1')(
      req,
      res as never,
    );
    const { ticket } = JSON.parse(body);
    vi.advanceTimersByTime(30001);
    expect(tickets.consume(ticket)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
it('restores an HttpOnly browser session through a one-use ticket, without giving JS the owner cookie', async () => {
  const identity = await generateChannelIdentity();
  const connection = {
    admit: ({ headers }: { headers: IncomingMessage['headers'] }) =>
      headers.cookie === 'owner=PRIVATE' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 },
  };
  const http = createServer((req, res) => {
    if (req.url === '/swiftnest/channel/bootstrap') channel.bootstrap(req, res);
    else res.writeHead(req.headers.cookie === 'owner=PRIVATE' ? 200 : 401).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const root = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`);
  const channel = appChannel(identity, () => root.origin, connection);
  http.on('upgrade', channel.handler);
  const pairing: ChannelPairing = { v: 1, key: channelPublicKey(identity), addresses: { lan: [root.href], relay: [] } };
  let client: AppChannel | undefined;
  try {
    expect((await fetch(new URL('swiftnest/channel/bootstrap', root), { method: 'POST' })).status).toBe(401);
    const response = await fetch(new URL('swiftnest/channel/bootstrap', root), {
      method: 'POST',
      headers: { cookie: 'owner=PRIVATE' },
    });
    const body = await response.text();
    expect(body).not.toContain('PRIVATE');
    const { ticket } = JSON.parse(body);
    const options = { createWebSocket: (url: string) => new WebSocket(url) };
    client = await AppChannel.open(
      root,
      pairing,
      options,
      { t: 'auth', browser: true, ticket },
      AbortSignal.timeout(3000),
    );
    expect(client.cookie).toBe('');
    expect((await client.fetch(new URL('swiftnest/health', root), {}, '')).status).toBe(200);
    await expect(
      AppChannel.open(root, pairing, options, { t: 'auth', browser: true, ticket }, AbortSignal.timeout(3000)),
    ).rejects.toThrow();
    const pending: WebSocket[] = [];
    for (let index = 0; index < 8; index++) {
      const socket = new WebSocket(new URL('swiftnest/channel', root).href.replace('http:', 'ws:'));
      socket.on('error', () => {});
      pending.push(socket);
      await once(socket, 'open');
    }
    const extra = new WebSocket(new URL('swiftnest/channel', root).href.replace('http:', 'ws:'));
    extra.on('error', () => {});
    await new Promise<void>((resolve) => extra.once('close', resolve));
    expect(extra.readyState).toBe(WebSocket.CLOSED);
    for (const socket of pending) socket.terminate();
  } finally {
    client?.close();
    channel.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
