import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { deviceProxy, liveTransportAllowed } from '../src/devices.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
});
async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close.push(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('uses owner admission and forwards only the parent credential and allowed route', async () => {
  const received: any[] = [];
  const upstream = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const admit = vi.fn().mockReturnValue({ rejection: 401 });
  const handler = deviceProxy({ admit }, upstream, 'parent-secret');
  const proxy = await listen((req, res) => void handler(req, res));
  const path = `${proxy}/swiftnest/api/devices/approvals/task/approve`;
  expect((await fetch(path, { method: 'POST' })).status).toBe(401);
  admit.mockReturnValue({ peer: { principal: { kind: 'agent' } } });
  expect((await fetch(path, { method: 'POST' })).status).toBe(403);
  expect(received).toEqual([]);
  admit.mockReturnValue({ peer: { principal: { kind: 'owner' } } });
  const response = await fetch(path, {
    method: 'POST',
    headers: { cookie: 'owner-cookie', authorization: 'untrusted', origin: proxy },
    body: '{"target":"http://bad"}',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(received).toMatchObject([
    {
      method: 'POST',
      url: '/swiftnest/api/devices/approvals/task/approve',
      body: '',
      headers: { authorization: 'Bearer parent-secret' },
    },
  ]);
  expect(received[0].headers).not.toHaveProperty('cookie');
  expect(received[0].headers).not.toHaveProperty('origin');
  expect((await fetch(path, { method: 'DELETE' })).status).toBe(405);
  expect((await fetch(`${proxy}/swiftnest/control/devices/call`, { method: 'POST' })).status).toBe(404);
  expect((await fetch(`${proxy}/swiftnest/api/devices/%2e%2e/%2e%2e/control/devices`)).status).toBe(404);
  expect(received).toHaveLength(1);
});
it('refuses a non-loopback admin URL', () => {
  expect(() => deviceProxy({ admit: () => ({ rejection: 401 }) }, 'http://other.test', 'secret')).toThrow('loopback');
});

it('requires TLS for remote live transport and ignores untrusted forwarded protocol headers', () => {
  const request = (remoteAddress: string, encrypted = false) => ({ socket: { remoteAddress, encrypted } }) as any;
  expect(liveTransportAllowed(request('192.168.1.2'))).toBe(false);
  expect(liveTransportAllowed(request('192.168.1.2', true))).toBe(true);
  expect(liveTransportAllowed(request('127.0.0.1'))).toBe(true);
});

it('forwards a bounded transfer request only after owner admission; never proxies the private transfer route', async () => {
  let received = '';
  const upstream = await listen(async (req, res) => {
    for await (const chunk of req) received += chunk;
    res.end('{}');
  });
  const admit = vi.fn().mockReturnValue({ peer: { principal: { kind: 'agent' } } });
  const handler = deviceProxy({ admit }, upstream, 'secret');
  const proxy = await listen((req, res) => void handler(req, res));
  const path = `${proxy}/swiftnest/api/devices/transfers`;
  const body = JSON.stringify({ source: { device: 'a', path: 'video' }, destination: { device: 'b', path: 'video' } });
  expect((await fetch(path, { method: 'POST', body })).status).toBe(403);
  expect(received).toBe('');
  admit.mockReturnValue({ peer: { principal: { kind: 'owner' } } });
  expect((await fetch(path, { method: 'POST', body })).status).toBe(200);
  expect(received).toBe(body);
  expect((await fetch(path, { method: 'POST', body: 'x'.repeat(32769) })).status).toBe(413);
  expect((await fetch(`${proxy}/swiftnest/control/devices/transfers`, { method: 'POST', body })).status).toBe(404);
});
