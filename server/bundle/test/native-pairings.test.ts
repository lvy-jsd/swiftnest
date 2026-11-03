import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { nativePairings, type NativeConnection } from '../src/native-pairings.js';
import { NativePairings, type NativeGrant } from '../src/native-pairings-store.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function peer(principal = { kind: 'owner' }, interactions: 'answer' | 'none' = 'none') {
  const lifetime = new AbortController();
  return {
    principal,
    interactions,
    signal: lifetime.signal,
    dispose: vi.fn(async () => {
      lifetime.abort();
    }),
  };
}
function setup(endpoint = 'http://127.0.0.1:1') {
  const home = mkdtempSync(join(tmpdir(), 'native-admission-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const bootstrap = peer();
  const browserPeer = peer();
  const createPeer = vi.fn((grant: NativeGrant) => peer(grant.principal, grant.interactions));
  const original = vi.fn((req) => {
    if (req.headers.origin || req.headers.host === 'untrusted') return { rejection: 403 };
    if (req.headers.cookie === 'bootstrap=valid') return { peer: bootstrap };
    if (req.headers.cookie === 'browser=valid') return { peer: browserPeer };
    return { rejection: 401 };
  });
  const connection: NativeConnection = { admit: original, createPeer, browserPeer };
  const native = nativePairings(connection, home, endpoint, 'parent-secret');
  cleanup.push(native.close);
  const store = new NativePairings(join(home, 'native-pairings.json'));
  return { connection, createPeer, native, store, bootstrap, browserPeer, original };
}
const request = (token: string, host = 'server') => ({ headers: { host, cookie: `swiftnest_native=${token}` } });

it('restores exactly the original scope, keeps the DSH fence, and disposes revoked live Peers', async () => {
  const { store, connection, createPeer, native, original } = setup();
  const { credential, record } = store.issue({ principal: { kind: 'owner' }, interactions: 'none' }, 'http://server');
  expect(connection.admit(request(credential))).toHaveProperty('peer');
  expect(createPeer).toHaveBeenCalledExactlyOnceWith({ principal: { kind: 'owner' }, interactions: 'none' });
  connection.admit(request(credential));
  expect(createPeer).toHaveBeenCalledTimes(1);
  expect(connection.admit(request(credential, 'untrusted'))).toEqual({ rejection: 403 });
  expect(connection.admit(request(credential, 'other'))).toEqual({ rejection: 401 });
  expect(
    connection.admit({ headers: { host: 'server', origin: 'https://evil', cookie: `swiftnest_native=${credential}` } }),
  ).toEqual({ rejection: 403 });
  expect(
    connection.admit({
      headers: { host: 'server', cookie: `swiftnest_native=${credential}; swiftnest_native=${credential}` },
    }),
  ).toEqual({ rejection: 401 });
  const restored = createPeer.mock.results[0]!.value;
  store.revoke(record.id);
  expect(connection.admit(request(credential))).toEqual({ rejection: 401 });
  native.invalidate();
  expect(restored.signal.aborted).toBe(true);
  const expiring = store.issue({ principal: { kind: 'owner' }, interactions: 'answer' }, 'http://server');
  connection.admit(request(expiring.credential));
  writeFileSync(store.file, 'corrupt');
  native.invalidate();
  expect(createPeer.mock.results[1]!.value.signal.aborted).toBe(true);
  expect(connection.admit(request(expiring.credential))).toEqual({ rejection: 401 });
  native.close();
  expect(connection.admit).toBe(original);
});
async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('exchanges the bootstrap once, uses only the admitted grant, and refuses browser, query and unsupported issue paths', async () => {
  const received: any[] = [];
  const parent = await listen(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ body: JSON.parse(raw), headers: req.headers, path: req.url });
    res.end(JSON.stringify({ credential: 'x'.repeat(43) }));
  });
  const { native, bootstrap, browserPeer } = setup(parent);
  const root = await listen((req, res) => void native.handler(req, res));
  const issue = (path = 'issue', cookie = 'bootstrap=valid', body = '{}', origin?: string) =>
    fetch(`${root}/swiftnest/native/${path}`, {
      method: 'POST',
      headers: { cookie, ...(origin ? { origin } : {}) },
      body,
    });
  expect((await issue('issue', 'browser=valid')).status).toBe(403);
  expect(browserPeer.signal.aborted).toBe(false);
  expect((await issue('issue?credential=bad')).status).toBe(404);
  expect((await issue('resume')).status).toBe(401);
  expect((await issue('issue', 'bootstrap=valid', '{}', 'https://evil')).status).toBe(403);
  expect((await issue('issue', 'bootstrap=valid', '[]')).status).toBe(400);
  expect(
    (
      await issue(
        'issue',
        'bootstrap=valid',
        JSON.stringify({ grant: { principal: { kind: 'owner' }, interactions: 'answer' } }),
      )
    ).status,
  ).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    path: '/swiftnest/control/native/issue',
    headers: { authorization: 'Bearer parent-secret' },
    body: {
      grant: { principal: { kind: 'owner' }, interactions: 'none' },
      audience: root,
    },
  });
  expect(received[0].headers).not.toHaveProperty('cookie');
  expect(bootstrap.signal.aborted).toBe(true);
  expect((await issue()).status).toBe(401);
});

it('leaves unchanged idle streams alone, and detects parent revocation on the next one-second check', async () => {
  vi.useFakeTimers();
  const { store, connection, createPeer, native } = setup();
  const { credential, record } = store.issue({ principal: { kind: 'owner' }, interactions: 'answer' }, 'http://server');
  connection.admit(request(credential));
  native.invalidate();
  const verify = vi.spyOn(NativePairings.prototype, 'verify');
  const read = vi.spyOn(NativePairings.prototype, 'list');
  await vi.advanceTimersByTimeAsync(5000);
  expect(verify).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  const restored = createPeer.mock.results[0]!.value;
  expect(restored.signal.aborted).toBe(false);
  store.revoke(record.id);
  read.mockClear();
  await vi.advanceTimersByTimeAsync(999);
  expect(restored.signal.aborted).toBe(false);
  expect(verify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(restored.signal.aborted).toBe(true);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(verify).toHaveBeenCalledTimes(1);
  native.close();
  expect(vi.getTimerCount()).toBe(0);
});
it('expires open streams at each next deadline without reading or re-verifying an unchanged file', async () => {
  vi.useFakeTimers();
  const { store, connection, createPeer, native } = setup();
  const grant: NativeGrant = { principal: { kind: 'owner' }, interactions: 'none' };
  const first = store.issue(grant, 'http://server');
  const second = store.issue(grant, 'http://server');
  writeFileSync(
    store.file,
    JSON.stringify([
      { ...first.record, expiresAt: Date.now() + 4500 },
      { ...second.record, expiresAt: Date.now() + 2500 },
    ]),
  );
  connection.admit(request(first.credential));
  connection.admit(request(second.credential));
  native.invalidate();
  const read = vi.spyOn(NativePairings.prototype, 'list');
  const verify = vi.spyOn(NativePairings.prototype, 'verify');
  const later = createPeer.mock.results[0]!.value;
  const sooner = createPeer.mock.results[1]!.value;
  await vi.advanceTimersByTimeAsync(2499);
  expect(sooner.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(sooner.signal.aborted).toBe(true);
  expect(later.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(later.signal.aborted).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  native.close();
  expect(vi.getTimerCount()).toBe(0);
});
