import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  clientAddress,
  HandshakeLimits,
  RELAY_MAX_FRAME,
  RELAY_PATH,
  relayConfig,
  type RelayHello,
} from '@swiftnest/channel';
import { Budget, DEFAULT_LIMITS, type RelayLimits } from './limits.js';

interface Group {
  waiting: Set<WebSocket>;
  sockets: Set<WebSocket>;
  budget: Budget;
}
export interface RelayOptions {
  secret: string;
  host?: string;
  port?: number;
  limits?: Partial<RelayLimits>;
  trustedProxyIp?: string;
}
function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const bytes = Buffer.from(given);
  const secret = Buffer.from(expected);
  return bytes.length === secret.length && timingSafeEqual(bytes, secret);
}
function rawSize(data: RawData): number {
  return Array.isArray(data) ? data.reduce((sum, item) => sum + item.length, 0) : data.byteLength;
}
function helloOf(data: RawData, secret: string): RelayHello {
  if (rawSize(data) > 1024) throw new Error('Registration too large');
  const hello = JSON.parse(data.toString()) as RelayHello;
  if (
    !sameSecret(hello.secret, secret) ||
    !/^[A-Za-z0-9_-]{43}$/.test(hello.id) ||
    !['app', 'server'].includes(hello.role)
  )
    throw new Error('Registration refused');
  return hello;
}
function forward(source: WebSocket, target: WebSocket, budget: Budget) {
  source.on('message', (data, binary) => {
    if (
      !binary ||
      rawSize(data) > RELAY_MAX_FRAME ||
      !budget.take(rawSize(data)) ||
      target.readyState !== WebSocket.OPEN ||
      target.bufferedAmount > RELAY_MAX_FRAME * 2
    ) {
      source.terminate();
      target.terminate();
      return;
    }
    target.send(data, { binary: true });
  });
  source.once('close', () => target.terminate());
}
function relaySockets(http: Server, options: RelayOptions, limits: RelayLimits) {
  const groups = new Map<string, Group>();
  const handshakes = new HandshakeLimits();
  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_FRAME, perMessageDeflate: false });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== RELAY_PATH || wss.clients.size >= limits.connections) return socket.destroy();
    const release = handshakes.enter(clientAddress(req, options.trustedProxyIp));
    if (!release) return socket.destroy();
    socket.once('close', release);
    wss.handleUpgrade(req, socket, head, (wire) => {
      wire.once('message', release);
      register(wire, options.secret, groups, limits);
    });
  });
  return wss;
}
function keepAlive(wss: WebSocketServer) {
  const unresponsive = new WeakSet<WebSocket>();
  return setInterval(() => {
    for (const socket of wss.clients) {
      if (unresponsive.has(socket)) socket.terminate();
      else {
        unresponsive.add(socket);
        socket.once('pong', () => unresponsive.delete(socket));
        socket.ping();
      }
    }
  }, 30000);
}
/** Memory-only rendezvous: never parses, logs, persists or decrypts forwarded bytes. */
export async function startRelay(options: RelayOptions) {
  relayConfig({ address: 'http://127.0.0.1/', secret: options.secret });
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid relay limit');
  const http = createServer((req, res) => {
    res.writeHead(req.method === 'GET' && req.url === '/health' ? 200 : 404).end();
  });
  const wss = relaySockets(http, options, limits);
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 8787, options.host ?? '127.0.0.1', resolve);
  });
  const heartbeat = keepAlive(wss);
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${(http.address() as AddressInfo).port}/`,
    async close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
function register(wire: WebSocket, secret: string, groups: Map<string, Group>, limits: RelayLimits) {
  wire.on('error', () => wire.terminate());
  const timer = setTimeout(() => wire.terminate(), 5000);
  wire.once('close', () => clearTimeout(timer));
  wire.once('message', (data) => {
    clearTimeout(timer);
    try {
      const hello = helloOf(data, secret);
      let group = groups.get(hello.id);
      if (!group && hello.role === 'server') {
        group = { waiting: new Set(), sockets: new Set(), budget: new Budget(limits) };
        groups.set(hello.id, group);
      }
      if (!group || group.sockets.size >= limits.perServer * 2) throw new Error('Connection limit');
      attach(wire, hello, group, limits);
      wire.once('close', () => {
        group.waiting.delete(wire);
        group.sockets.delete(wire);
        if (!group.sockets.size) groups.delete(hello.id);
      });
    } catch {
      wire.terminate();
    }
  });
}
function attach(wire: WebSocket, hello: RelayHello, group: Group, limits: RelayLimits) {
  if (hello.role === 'server') {
    const paired = (group.sockets.size - group.waiting.size) / 2;
    if (group.waiting.size + paired >= limits.perServer) throw new Error('Server connection limit');
    group.waiting.add(wire);
    wire.send('{"t":"waiting"}');
    // Idle connections must never inject bytes before an App has arrived.
    wire.once('message', premature);
  } else {
    const server = group.waiting.values().next().value;
    if (!server || server.readyState !== WebSocket.OPEN) throw new Error('Server unavailable');
    group.waiting.delete(server);
    server.off('message', premature);
    forward(server, wire, group.budget);
    forward(wire, server, group.budget);
    server.send('{"t":"paired"}');
    wire.send('{"t":"paired"}');
  }
  group.sockets.add(wire);
}
function premature(this: WebSocket) {
  this.terminate();
}
