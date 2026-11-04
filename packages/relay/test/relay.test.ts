import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  relaySocketUrl,
  relayServerId,
  channelPublicKey,
  generateChannelIdentity,
  RELAY_MAX_FRAME,
} from '@swiftnest/channel';
import { startRelay } from '../src/index.js';

const secret = 's'.repeat(32);
const id = 'a'.repeat(43);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(limits = {}) {
  const relay = await startRelay({ secret, port: 0, limits });
  cleanup.push(relay.close);
  return relay;
}
async function wire(url: string, role: string, overrides = {}, wait = true) {
  const socket = new WebSocket(relaySocketUrl(url));
  socket.on('error', () => {});
  await once(socket, 'open');
  socket.send(JSON.stringify({ role, id, secret, ...overrides }));
  if (wait && role === 'server' && Object.keys(overrides).length === 0) {
    await Promise.race([once(socket, 'message'), once(socket, 'close')]);
  }
  return socket;
}
async function linked(limits = {}) {
  const relay = await fixture(limits);
  const server = await wire(relay.url, 'server');
  const paired = once(server, 'message');
  const app = await wire(relay.url, 'app');
  await Promise.all([paired, once(app, 'message')]);
  return { app, server, relay };
}
it('forwards opaque binary bytes in both directions and closes the other end', async () => {
  const { app, server } = await linked();
  const incoming = once(server, 'message');
  app.send(Buffer.from([0, 255, 1]));
  expect((await incoming)[0]).toEqual(Buffer.from([0, 255, 1]));
  const outgoing = once(app, 'message');
  server.send(Buffer.from([5, 4, 3]));
  expect((await outgoing)[0]).toEqual(Buffer.from([5, 4, 3]));
  const closed = once(server, 'close');
  app.close();
  await closed;
});
it('fails a bind cleanly so a supervisor can restart it', async () => {
  const relay = await fixture();
  await expect(startRelay({ secret, port: Number(new URL(relay.url).port) })).rejects.toMatchObject({
    code: 'EADDRINUSE',
  });
});
it.each(['app', 'server'])('rejects wrong secrets for %s without logging credentials', async (role) => {
  const relay = await fixture();
  const socket = await wire(relay.url, role, { secret: 'wrong' });
  await once(socket, 'close');
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});
it('refuses unknown server ids and derives a stable distinct id from the R1 key', async () => {
  const relay = await fixture();
  await wire(relay.url, 'server');
  const wrong = await wire(relay.url, 'app', { id: 'b'.repeat(43) });
  await once(wrong, 'close');
  const key = channelPublicKey(await generateChannelIdentity());
  expect(await relayServerId(key)).toBe(await relayServerId(key));
  expect(await relayServerId(key)).not.toBe(await relayServerId(channelPublicKey(await generateChannelIdentity())));
});
it('caps connections per server and releases the slot after close', async () => {
  const relay = await fixture({ perServer: 1 });
  const first = await wire(relay.url, 'server');
  const extra = await wire(relay.url, 'server', {}, false);
  await once(extra, 'close');
  const closed = once(first, 'close');
  first.close();
  await closed;
  const next = await wire(relay.url, 'server');
  const paired = once(next, 'message');
  const app = await wire(relay.url, 'app');
  await paired;
  app.close();
});
it.each(['size', 'bytes', 'frames', 'text'])('disconnects traffic exceeding %s limits', async (limit) => {
  const { app, server } = await linked(
    limit === 'bytes' ? { burstBytes: 32 } : limit === 'frames' ? { framesPerSecond: 1 } : {},
  );
  const closed = once(server, 'close');
  if (limit === 'size') app.send(Buffer.alloc(RELAY_MAX_FRAME + 1));
  else if (limit === 'bytes') app.send(Buffer.alloc(33));
  else if (limit === 'text') app.send('not binary');
  else {
    app.send(Buffer.alloc(1));
    app.send(Buffer.alloc(1));
  }
  await closed;
});

it.each([false, true])('bounds unregistered sockets per IP (explicit proxy trust: %s)', async (trusted) => {
  const relay = await startRelay({ secret, port: 0, trustedProxyIp: trusted ? '127.0.0.1' : undefined });
  cleanup.push(relay.close);
  const open = (ip: string) => {
    const socket = new WebSocket(relaySocketUrl(relay.url), { headers: { 'x-forwarded-for': `spoof, ${ip}` } });
    socket.on('error', () => {});
    return socket;
  };
  const pending: WebSocket[] = [];
  for (let index = 0; index < 8; index++) {
    const socket = open('192.0.2.1');
    pending.push(socket);
    await once(socket, 'open');
  }
  const extra = open('192.0.2.1');
  await new Promise<void>((resolve) => extra.once('close', resolve));
  const otherIp = open('192.0.2.2');
  if (trusted) {
    await once(otherIp, 'open');
    expect(otherIp.readyState).toBe(WebSocket.OPEN);
    otherIp.terminate();
  } else await new Promise<void>((resolve) => otherIp.once('close', resolve));
  const closed = once(pending[0]!, 'close');
  pending[0]!.terminate();
  await closed;
  const replacement = open('192.0.2.1');
  await once(replacement, 'open');
  replacement.terminate();
  for (const socket of pending) socket.terminate();
});
