import { BrowserTickets } from './browser-tickets.js';
import { normalizeChannelProxy } from './trusted-proxy.js';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CHANNEL_PATH,
  MAX_MESSAGE,
  EncryptedChannel,
  channelFrame,
  channelRoute,
  decodeBytes,
  encodeBytes,
  type ChannelFrame,
  type ChannelIdentity,
  type ChannelPairing,
  RELAY_MAX_MESSAGE,
  HandshakeLimits,
  clientAddress,
  relayRoute,
} from '@swiftnest/channel';
import { appMuxFrame } from '@swiftnest/channel';
import { text, render } from '@swiftnest/protocol';
import type { DeviceConnection } from './devices.js';

const MAX_OPERATIONS = 64;
const validId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;
function cookieHeaders(cookie: unknown): Record<string, string> {
  if (typeof cookie !== 'string' || cookie.length > 8192 || /[\r\n]/.test(cookie))
    throw new Error('Invalid credential');
  return { cookie };
}

/** Fixed local destination. The remote cannot choose a host, port, forwarded header, or private control route. */
class AppBridge {
  private operations = new Map<number, () => void>();
  private sockets = new Map<number, WebSocket>();
  private muxSockets = new Set<number>();
  private stopped = false;
  private browserCookie?: string;
  constructor(
    private channel: EncryptedChannel,
    private origin: URL,
    private connection: DeviceConnection,
    private authenticated: () => void,
    private carrier: IncomingMessage['socket'] | undefined,
    private metadata?: () => { pairing: ChannelPairing; relaySecret?: string },
    private viaRelay = false,
    private tickets?: BrowserTickets,
  ) {}
  private send(frame: ChannelFrame) {
    if (this.stopped) return;
    try {
      if (this.viaRelay && Buffer.byteLength(JSON.stringify(frame)) > RELAY_MAX_MESSAGE)
        throw new Error('Relay message too large');
      this.channel.send(frame);
    } catch {
      this.close();
    }
  }
  private admit(headers: Record<string, string>) {
    // Relay sockets have no inbound HTTP carrier. Match the fixed local listener's
    // protocol so durable native credentials retain their original TLS audience.
    const socket =
      this.carrier ?? ({ encrypted: this.origin.protocol === 'https:' } as unknown as IncomingMessage['socket']);
    return this.connection.admit({ headers: { host: this.origin.host, ...headers }, socket });
  }
  async run() {
    try {
      const auth = channelFrame(await this.channel.next());
      if (auth.t !== 'auth') throw new Error('Authentication required');
      let cookie = auth.ticket ? this.tickets?.consume(auth.ticket) : auth.cookie;
      if (auth.token) {
        try {
          cookie = await this.pair(auth);
        } catch {
          this.send({ t: 'error', status: 401 });
          return;
        }
      }
      const admission = this.admit(cookieHeaders(cookie));
      if ('rejection' in admission) {
        this.send({ t: 'error', status: admission.rejection });
        return;
      }
      if (auth.browser) this.browserCookie = cookie;
      this.authenticated();
      const owner = admission.peer.principal.kind === 'owner';
      this.send({
        t: 'ready',
        cookie: auth.browser ? '' : cookie,
        ...this.metadata?.(),
        ...(owner ? {} : { relaySecret: undefined }),
      });
      for (;;) this.dispatch(channelFrame(await this.channel.next()));
    } finally {
      this.close();
    }
  }
  private pair(auth: ChannelFrame): Promise<string> {
    if (typeof auth.token !== 'string' || auth.token.length > 2048) throw new Error('Invalid pairing');
    const url = new URL(auth.browser ? '/' : '/connect', this.origin);
    url.searchParams.set('token', auth.token);
    if (!auth.browser) url.searchParams.set('interactions', auth.interactions === 'none' ? 'none' : 'answer');
    return new Promise((resolve, reject) => {
      const req = this.localRequest(url, {}, (res) => {
        res.resume();
        const cookie = res.headers['set-cookie']?.map((value) => value.split(';')[0]).join('; ');
        if (res.statusCode !== (auth.browser ? 303 : 302) || !cookie) reject(new Error('Pairing refused'));
        else resolve(cookie);
      });
      req.on('error', reject);
      req.end();
    });
  }
  private localRequest(
    url: URL,
    options: import('node:http').RequestOptions,
    response: (res: IncomingMessage) => void,
  ) {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response);
    req.setTimeout(15000, () => req.destroy());
    return req;
  }
  private dispatch(frame: ChannelFrame) {
    if (!validId(frame.id)) throw new Error('Invalid operation');
    const id = frame.id;
    if (frame.t === 'cancel') {
      this.operations.get(id)?.();
      this.operations.delete(id);
      return;
    }
    if (frame.t === 'message') {
      const socket = this.sockets.get(id);
      if (!socket || socket.readyState !== WebSocket.OPEN || typeof frame.body !== 'string')
        throw new Error('Invalid socket');
      if (socket.bufferedAmount > 8 * 1024 * 1024) throw new Error('Socket backlog exceeded');
      if (this.muxSockets.has(id) && !appMuxFrame(frame.body, frame.binary)) throw new Error('App stream refused');
      socket.send(frame.binary ? decodeBytes(frame.body) : frame.body);
      return;
    }
    if (!['request', 'socket'].includes(frame.t) || this.operations.has(id) || this.operations.size >= MAX_OPERATIONS)
      throw new Error('Invalid operation');
    const method = frame.t === 'socket' ? 'WS' : (frame.method ?? 'GET');
    if (typeof frame.path !== 'string' || !channelRoute(method, frame.path)) {
      this.send({ t: 'error', id, status: 404 });
      return;
    }
    if (this.viaRelay && (!relayRoute(frame.path) || Buffer.byteLength(JSON.stringify(frame)) > RELAY_MAX_MESSAGE)) {
      this.send({ t: 'response', id, status: 413, headers: { 'content-type': 'application/json' } });
      this.send({
        t: 'data',
        id,
        body: encodeBytes(
          new TextEncoder().encode(
            JSON.stringify({ message: render(text('relayLanOnly')), text: text('relayLanOnly') }),
          ),
        ),
      });
      this.send({ t: 'end', id });
      return;
    }
    const headers = cookieHeaders(this.browserCookie ?? frame.cookie);
    const admission = this.admit(headers);
    if ('rejection' in admission) {
      this.send({ t: 'error', id, status: admission.rejection });
      return;
    }
    if (frame.t === 'socket') this.openSocket(id, frame.path, headers);
    else this.request(id, frame, headers);
  }
  private request(id: number, frame: ChannelFrame, headers: Record<string, string>) {
    for (const key of ['content-type', 'accept-language']) {
      const value = frame.headers?.[key];
      if (typeof value === 'string' && value.length < 256 && !/[\r\n]/.test(value)) headers[key] = value;
    }
    if (frame.body !== undefined && typeof frame.body !== 'string') throw new Error('Invalid body');
    const req = this.localRequest(
      new URL(frame.path!, this.origin),
      { method: frame.method ?? 'GET', headers },
      (res) => {
        this.send({
          t: 'response',
          id,
          status: res.statusCode,
          headers: { 'content-type': res.headers['content-type'] ?? 'application/octet-stream' },
        });
        res.on('data', (chunk: Buffer) => {
          for (let offset = 0; offset < chunk.length; offset += 16384)
            this.send({ t: 'data', id, body: encodeBytes(chunk.subarray(offset, offset + 16384)) });
        });
        res.on('end', () => this.finish(id));
        res.on('error', () => this.finish(id, 502));
        // SSE is intentionally long lived; the channel's cancellation owns it.
        req.setTimeout(0);
      },
    );
    this.operations.set(id, () => req.destroy());
    req.on('error', () => this.finish(id, 502));
    req.end(frame.body);
  }
  private openSocket(id: number, path: string, headers: Record<string, string>) {
    const url = new URL(path, this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (path === '/api/remote.mux') this.muxSockets.add(id);
    const socket = new WebSocket(url, { headers, maxPayload: MAX_MESSAGE, handshakeTimeout: 10000 });
    this.sockets.set(id, socket);
    this.operations.set(id, () => {
      socket.terminate();
      this.sockets.delete(id);
      this.muxSockets.delete(id);
    });
    socket.on('open', () => this.send({ t: 'opened', id }));
    socket.on('message', (data, binary) =>
      this.send({
        t: 'message',
        id,
        binary,
        body: binary ? encodeBytes(new Uint8Array(data as Buffer)) : data.toString(),
      }),
    );
    socket.on('error', () => this.finish(id, 502));
    socket.on('close', () => this.finish(id));
  }
  private finish(id: number, status?: number) {
    if (!this.operations.has(id)) return;
    this.operations.get(id)?.();
    this.operations.delete(id);
    this.sockets.delete(id);
    this.send({ t: status ? 'error' : 'end', id, status });
  }
  close() {
    this.stopped = true;
    for (const stop of this.operations.values()) stop();
    this.operations.clear();
    this.channel.close();
  }
}

class BridgeSessions {
  private bridges = new Set<AppBridge>();
  readonly tickets = new BrowserTickets();
  constructor(
    private identity: ChannelIdentity,
    private origin: () => string,
    private connection: DeviceConnection,
    private metadata?: () => { pairing: ChannelPairing; relaySecret?: string },
  ) {}
  async accept(wire: WebSocket, viaRelay = true, carrier?: IncomingMessage['socket'], release = () => {}) {
    const timer = setTimeout(() => wire.terminate(), 15000);
    try {
      const channel = await EncryptedChannel.open(wire, this.identity, false);
      const bridge = new AppBridge(
        channel,
        new URL(this.origin()),
        this.connection,
        () => {
          clearTimeout(timer);
          release();
        },
        carrier,
        this.metadata,
        viaRelay,
        this.tickets,
      );
      this.bridges.add(bridge);
      try {
        await bridge.run();
      } finally {
        this.bridges.delete(bridge);
      }
    } finally {
      clearTimeout(timer);
      release();
    }
  }
  close() {
    this.tickets.close();
    for (const bridge of this.bridges) bridge.close();
  }
}

export function appChannel(
  identity: ChannelIdentity,
  origin: () => string,
  connection: DeviceConnection,
  metadata?: () => { pairing: ChannelPairing; relaySecret?: string },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE + 4096 });
  const handshakes = new HandshakeLimits();
  const sessions = new BridgeSessions(identity, origin, connection, metadata);
  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (wss.clients.size >= 128) return socket.destroy();
    const target = new URL(origin());
    if (
      !normalizeChannelProxy(req, target) ||
      req.url !== CHANNEL_PATH ||
      req.headers.host !== target.host ||
      (req.headers.origin && req.headers.origin !== target.origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const release = handshakes.enter(clientAddress(req, process.env.SWIFTNEST_TRUSTED_PROXY_IP));
    if (!release) return socket.destroy();
    socket.once('close', release);
    wss.handleUpgrade(req, socket, head, (wire) => {
      void sessions.accept(wire, false, req.socket, release).catch(() => wire.terminate());
    });
  };
  return {
    handler,
    bootstrap: sessions.tickets.handler(connection, origin),
    signIn: sessions.tickets.signIn(origin),
    accept: (wire: WebSocket) => sessions.accept(wire),
    close() {
      sessions.close();
      for (const wire of wss.clients) wire.terminate();
      wss.close();
    },
  };
}
