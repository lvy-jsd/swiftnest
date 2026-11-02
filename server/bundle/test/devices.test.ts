import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { deviceProxy } from '../src/devices.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  close.push(async () => { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('uses owner admission and forwards only the parent credential and allowed route', async () => {
  const received: any[] = [];
  const upstream = await listen(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
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
  const response = await fetch(path, { method: 'POST', headers: { cookie: 'owner-cookie', authorization: 'untrusted', origin: proxy }, body: '{"target":"http://bad"}' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(received).toMatchObject([{ method: 'POST', url: '/swiftnest/api/devices/approvals/task/approve', body: '', headers: { authorization: 'Bearer parent-secret' } }]);
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
