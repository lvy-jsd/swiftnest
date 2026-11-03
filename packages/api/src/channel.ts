import {
  CHANNEL_PATH,
  EncryptedChannel,
  generateChannelIdentity,
  channelFrame,
  decodeBytes,
  encodeBytes,
  type ChannelFrame,
  joinRelay,
  relayServerId,
  relaySocketUrl,
  relayRoute,
  RELAY_MAX_MESSAGE,
  relayAddress,
  type ChannelPairing,
} from '@swiftnest/channel';
import { text } from '@swiftnest/protocol';
import { ApiError } from './transport.js';
import type { ApiWebSocket, ClientOptions, SocketEventMap } from './types.js';
export type { ChannelPairing } from '@swiftnest/channel';

export function pairingChannel(url: URL): ChannelPairing | undefined {
  if (!url.hash) return;
  try {
    const encoded = new URLSearchParams(url.hash.slice(1)).get('sn');
    if (!encoded) throw new Error('Missing channel pairing');
    const value = JSON.parse(new TextDecoder().decode(decodeBytes(encoded))) as ChannelPairing;
    if (
      value.v !== 1 ||
      decodeBytes(value.key).length !== 32 ||
      !value.addresses ||
      !Array.isArray(value.addresses.lan) ||
      !Array.isArray(value.addresses.relay)
    )
      throw new Error('Invalid channel pairing');
    const addresses = [...value.addresses.lan, ...value.addresses.relay];
    if (addresses.length > 8 || !addresses.length) throw new Error('Invalid addresses');
    for (const address of value.addresses.relay) relayAddress(address);
    for (const address of addresses) {
      const target = new URL(address);
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        target.pathname !== '/'
      )
        throw new Error('Invalid address');
    }
    if (!value.addresses.lan.includes(new URL('./', url).href)) throw new Error('Pairing address mismatch');
    return value;
  } catch {
    throw new ApiError('channel-key-mismatch', text('channelPairAgain'));
  }
}

class ChannelSocket implements ApiWebSocket {
  readyState = 0;
  private listeners = new Map<keyof SocketEventMap, Map<(event: never) => void, boolean>>();
  constructor(
    private sendFrame: (frame: ChannelFrame) => void,
    readonly id: number,
  ) {}
  addEventListener<K extends keyof SocketEventMap>(
    type: K,
    listener: (event: SocketEventMap[K]) => void,
    options?: { once?: boolean },
  ) {
    const group = this.listeners.get(type) ?? new Map();
    group.set(listener as (event: never) => void, options?.once ?? false);
    this.listeners.set(type, group);
  }
  removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void) {
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }
  emit<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const [listener, once] of [...(this.listeners.get(type) ?? [])]) {
      if (once) this.listeners.get(type)?.delete(listener);
      listener(event as never);
    }
  }
  send(data: string | Uint8Array<ArrayBuffer>) {
    if (this.readyState !== 1) throw new ApiError('disconnected', text('apiSocketClosed'));
    this.sendFrame({
      t: 'message',
      id: this.id,
      binary: typeof data !== 'string',
      body: typeof data === 'string' ? data : encodeBytes(data),
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.sendFrame({ t: 'cancel', id: this.id });
    this.emit('close', {});
    this.listeners.clear();
  }
}

class ChannelResponse {
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  constructor(
    private resolve: (response: Response) => void,
    private cleanup: () => void,
    private cancel: () => void,
  ) {}
  receive(frame: ChannelFrame) {
    if (frame.t === 'response') {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
        },
        cancel: this.cancel,
      });
      const empty = [204, 205, 304].includes(frame.status ?? 200);
      this.resolve(new Response(empty ? null : body, { status: frame.status, headers: frame.headers }));
    } else if (frame.t === 'data' && frame.body) this.controller?.enqueue(decodeBytes(frame.body));
    else if (frame.t === 'end') {
      this.cleanup();
      this.controller?.close();
    } else if (frame.t === 'error') {
      this.cleanup();
      if (this.controller) this.abort(new ApiError('disconnected', text('apiSocketClosed')));
      else this.resolve(new Response(null, { status: frame.status ?? 502 }));
    } else throw new Error('Invalid response frame');
  }
  abort(error: unknown) {
    this.controller?.error(error);
  }
}

/** HTTP responses (including SSE) and virtual WebSockets share one encrypted socket. */
export class AppChannel {
  private nextId = 0;
  private muxId?: number;
  private handlers = new Map<number, (frame: ChannelFrame) => void>();
  private sockets = new Map<number, ChannelSocket>();
  private closed = false;
  cookie = '';
  pairing?: ChannelPairing;
  relaySecret?: string;
  viaRelay = false;
  private constructor(private channel: EncryptedChannel) {}
  static async open(
    root: URL,
    pairing: ChannelPairing,
    options: ClientOptions,
    auth: ChannelFrame,
    signal: AbortSignal,
    relaySecret?: string,
  ): Promise<AppChannel> {
    const viaRelay = pairing.addresses.relay.includes(root.href);
    const target = viaRelay ? new URL(relaySocketUrl(root.href)) : new URL(CHANNEL_PATH, root);
    if (!viaRelay) target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const wire = options.createWebSocket
      ? options.createWebSocket(target.href, { headers: {} })
      : new WebSocket(target.href);
    wire.addEventListener('error', () => {});
    const abort = () => wire.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const identity = await generateChannelIdentity();
      let encrypted: EncryptedChannel;
      if (viaRelay) {
        if (!relaySecret) throw new Error('Missing relay secret');
        encrypted = await joinRelay(
          wire as import('@swiftnest/channel').ChannelSocket,
          {
            role: 'app',
            id: await relayServerId(pairing.key),
            secret: relaySecret,
          },
          signal,
          undefined,
          () => EncryptedChannel.open(wire, identity, true, pairing.key, signal),
        );
      } else encrypted = await EncryptedChannel.open(wire, identity, true, pairing.key, signal);
      return await AppChannel.authenticate(encrypted, auth, pairing.key, viaRelay);
    } catch (error) {
      wire.close();
      if (error instanceof Error && error.message === 'Channel key mismatch')
        throw new ApiError('channel-key-mismatch', text('channelPairAgain'));
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  private static async authenticate(
    encrypted: EncryptedChannel,
    auth: ChannelFrame,
    key: string,
    viaRelay: boolean,
  ): Promise<AppChannel> {
    encrypted.send(auth);
    const ready = channelFrame(await encrypted.next());
    if (ready.t !== 'ready' || typeof ready.cookie !== 'string') {
      encrypted.close();
      throw new ApiError(
        'pairing-failed',
        text('pairingReturnedHttp', ready.status ?? 401),
        undefined,
        undefined,
        ready.status ?? 401,
      );
    }
    const app = new AppChannel(encrypted);
    app.cookie = ready.cookie;
    app.viaRelay = viaRelay;
    if (ready.pairing && ready.pairing.key !== key)
      throw new ApiError('channel-key-mismatch', text('channelPairAgain'));
    app.pairing = ready.pairing;
    app.relaySecret = ready.relaySecret;
    void app.pump();
    return app;
  }
  static async preferred(
    root: URL,
    pairing: ChannelPairing,
    options: ClientOptions,
    auth: ChannelFrame,
    signal: AbortSignal,
  ) {
    const secret = await options.relaySecretStore?.load(root.href);
    const lan = pairing.addresses.lan;
    const targets = [...new Set([...(lan.includes(root.href) ? [root.href] : []), ...lan, ...pairing.addresses.relay])];
    let failure: unknown = new Error('No channel address');
    for (const address of targets) {
      signal.throwIfAborted();
      const local = pairing.addresses.lan.includes(address);
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(local ? 1800 : (options.timeoutMs ?? 15000))]);
      try {
        return await AppChannel.open(new URL(address), pairing, options, auth, attempt, secret);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        failure = error;
      }
    }
    throw failure;
  }
  socket(path: string, cookie: string): ApiWebSocket {
    if (this.viaRelay && !relayRoute(path)) throw new ApiError('relay-lan-only', text('relayLanOnly'));
    const id = ++this.nextId;
    if (path === '/api/remote.mux') this.muxId = id;
    const socket = new ChannelSocket((frame) => this.send(frame), id);
    this.sockets.set(id, socket);
    queueMicrotask(() => {
      if (socket.readyState !== 3) this.send({ t: 'socket', id, path, cookie });
    });
    return socket;
  }
  private send(frame: ChannelFrame) {
    if (this.closed) return;
    this.channel.send(frame);
    if (frame.t === 'cancel' && frame.id) this.sockets.delete(frame.id);
  }
  fetch(url: URL, init: RequestInit, cookie: string): Promise<Response> {
    if (
      this.viaRelay &&
      (!relayRoute(url.pathname) || new TextEncoder().encode(String(init.body ?? '')).length > RELAY_MAX_MESSAGE / 2)
    )
      return Promise.reject(new ApiError('relay-lan-only', text('relayLanOnly')));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.handlers.delete(id);
        init.signal?.removeEventListener('abort', abort);
      };
      const cancel = () => {
        cleanup();
        this.send({ t: 'cancel', id });
      };
      const abort = () => {
        const error = init.signal?.reason ?? new Error('Request aborted');
        cleanup();
        reject(error);
        response.abort(error);
        this.send({ t: 'cancel', id });
      };
      const response = new ChannelResponse(resolve, cleanup, cancel);
      if (init.signal?.aborted) {
        abort();
        return;
      }
      init.signal?.addEventListener('abort', abort, { once: true });
      this.handlers.set(id, (frame) => response.receive(frame));
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      try {
        this.send({
          t: 'request',
          id,
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers,
          cookie,
          ...(init.body === undefined ? {} : { body: String(init.body) }),
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  private async pump() {
    try {
      for (;;) {
        const frame = channelFrame(await this.channel.next());
        if (!frame.id) throw new Error('Invalid channel response');
        const socket = this.sockets.get(frame.id);
        if (!socket) {
          this.handlers.get(frame.id)?.(frame);
          continue;
        }
        if (frame.t === 'opened') socket.emit('open', {});
        else if (frame.t === 'message' && typeof frame.body === 'string')
          socket.emit('message', { data: frame.binary ? decodeBytes(frame.body).buffer : frame.body });
        else if (frame.t === 'end' || frame.t === 'error') {
          this.sockets.delete(frame.id);
          if (frame.t === 'error') socket.emit('error', {});
          socket.emit('close', {});
          if (frame.id === this.muxId) this.close();
        } else throw new Error('Invalid channel socket frame');
      }
    } catch {
      this.close();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    for (const handler of this.handlers.values()) handler({ t: 'error', status: 502 });
    for (const socket of this.sockets.values()) socket.emit('close', {});
    this.handlers.clear();
    this.sockets.clear();
  }
}
