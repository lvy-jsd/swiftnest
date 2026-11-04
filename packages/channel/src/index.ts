/** Noise XX from libp2p. This module only adapts sockets and frames application messages. */
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { noise, pureJsCrypto } from '@libp2p/noise';
import { AbstractMessageStream } from '@libp2p/utils';

export const CHANNEL_PATH = '/swiftnest/channel';
// Existing live-view binary frames can be 4 MiB, then gain JSON/base64 overhead here.
export const MAX_MESSAGE = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ChannelIdentity {
  /** Protobuf encoded Ed25519 private key. Never log this record. */
  signing: string;
  noise: string;
}
export interface ChannelPairing {
  v: 1;
  key: string;
  addresses: { lan: string[]; relay: string[] };
}
export function encodeBytes(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
}
export async function generateChannelIdentity(): Promise<ChannelIdentity> {
  return {
    signing: encodeBytes(privateKeyToProtobuf(await generateKeyPair('Ed25519'))),
    noise: encodeBytes(pureJsCrypto.generateX25519KeyPair().privateKey),
  };
}
export function channelPublicKey(identity: ChannelIdentity): string {
  const key = privateKeyFromProtobuf(decodeBytes(identity.signing));
  if (key.type !== 'Ed25519' || decodeBytes(identity.noise).length !== 32) throw new Error('Invalid channel identity');
  return encodeBytes(key.publicKey.raw);
}

/** Structural common denominator of browser, Node ws and the Tauri adapter. */
export interface ChannelSocket {
  readonly readyState: number;
  binaryType?: string;
  readonly bufferedAmount?: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error' | 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
}

// Noise's debug logger can print key material. Never connect it to application logging, even in debug mode.
const silent = Object.assign(() => {}, { enabled: false, error: () => {}, trace: () => {}, newScope: () => silent });
class SocketStream extends AbstractMessageStream {
  constructor(private socket: ChannelSocket) {
    super({ log: silent, maxReadBufferLength: MAX_MESSAGE * 2, maxWriteBufferLength: MAX_MESSAGE * 2 });
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', ({ data }) => {
      if (data instanceof ArrayBuffer) this.onData(new Uint8Array(data));
      else if (data instanceof Uint8Array) this.onData(data);
      else this.abort(new Error('Binary channel required'));
    });
    socket.addEventListener('close', () => this.onTransportClosed());
    socket.addEventListener('error', () => this.abort(new Error('Channel socket failed')));
  }
  sendData(data: Parameters<AbstractMessageStream['sendData']>[0]) {
    if ((this.socket.bufferedAmount ?? 0) > MAX_MESSAGE * 4) throw new Error('Channel backlog exceeded');
    this.socket.send(new Uint8Array(data.subarray()));
    return { sentBytes: data.byteLength, canSendMore: true };
  }
  sendReset() {
    this.socket.close();
  }
  sendPause() {}
  sendResume() {}
  async close() {
    this.socket.close();
    this.onTransportClosed();
  }
}

async function opened(socket: ChannelSocket, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (socket.readyState === 1) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', ready);
      socket.removeEventListener('close', fail);
      socket.removeEventListener('error', fail);
      signal.removeEventListener('abort', fail);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('Channel closed'));
    };
    socket.addEventListener('open', ready);
    socket.addEventListener('close', fail);
    socket.addEventListener('error', fail);
    signal.addEventListener('abort', fail, { once: true });
  });
}

/** Ordered, size-bounded application records over Noise's encrypted byte stream. */
export class EncryptedChannel {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private expected?: number;
  private messages: unknown[] = [];
  private waiting?: { resolve(value: unknown): void; reject(error: Error): void };
  private failure?: Error;
  private constructor(
    private stream:
      | AbstractMessageStream
      | Awaited<ReturnType<ReturnType<ReturnType<typeof noise>>['secureInbound']>>['connection'],
  ) {
    stream.addEventListener('message', (event) => {
      try {
        this.receive(event.data.subarray());
      } catch {
        this.close();
      }
    });
    stream.addEventListener('close', () => this.end());
    stream.addEventListener('end', () => this.end());
  }
  static async open(
    socket: ChannelSocket,
    identity: ChannelIdentity,
    initiator: boolean,
    key?: string,
    signal = AbortSignal.timeout(15000),
  ) {
    const raw = new SocketStream(socket);
    try {
      await opened(socket, signal);
      const privateKey = privateKeyFromProtobuf(decodeBytes(identity.signing));
      const peerId = peerIdFromPublicKey(privateKey.publicKey);
      const instance = noise({
        staticNoiseKey: decodeBytes(identity.noise),
        crypto: pureJsCrypto,
        prologueBytes: encoder.encode('swiftnest/app-channel/v1'),
      })({
        privateKey,
        peerId,
        logger: { forComponent: () => silent },
        upgrader: { getStreamMuxers: () => new Map() } as Parameters<ReturnType<typeof noise>>[0]['upgrader'],
      });
      const secured = await (initiator
        ? instance.secureOutbound(raw, { signal, skipStreamMuxerNegotiation: true })
        : instance.secureInbound(raw, { signal, skipStreamMuxerNegotiation: true }));
      if (key && encodeBytes(secured.remotePeer.publicKey!.raw) !== key) throw new Error('Channel key mismatch');
      return new EncryptedChannel(secured.connection);
    } catch (error) {
      raw.abort(new Error('Channel handshake failed'));
      throw error;
    }
  }
  send(value: unknown): void {
    if (this.failure) throw this.failure;
    const data = encoder.encode(JSON.stringify(value));
    if (data.length > MAX_MESSAGE) throw new Error('Channel message too large');
    const framed = new Uint8Array(data.length + 4);
    new DataView(framed.buffer).setUint32(0, data.length);
    framed.set(data, 4);
    this.stream.send(framed);
  }
  /** Chunks are joined once per record, so a large record is not recopied for every Noise frame. */
  private receive(data: Uint8Array) {
    this.chunks.push(data.slice());
    this.buffered += data.length;
    for (;;) {
      if (this.expected === undefined) {
        if (this.buffered < 4) return;
        this.expected = new DataView(this.take(4).buffer).getUint32(0);
        if (this.expected > MAX_MESSAGE) throw new Error('Channel message too large');
      }
      if (this.buffered < this.expected) return;
      const record = this.take(this.expected);
      this.expected = undefined;
      this.deliver(JSON.parse(decoder.decode(record)));
    }
  }
  private take(length: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.chunks[0]!;
      const used = Math.min(chunk.length, length - offset);
      out.set(chunk.subarray(0, used), offset);
      offset += used;
      if (used === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
    }
    this.buffered -= length;
    return out;
  }
  private deliver(value: unknown) {
    if (this.waiting) {
      const reader = this.waiting;
      this.waiting = undefined;
      reader.resolve(value);
      return;
    }
    if (this.messages.length >= 128) throw new Error('Channel backlog exceeded');
    this.messages.push(value);
  }
  next(): Promise<unknown> {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiting) return Promise.reject(new Error('Concurrent channel reader'));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
  private end() {
    this.failure ??= new Error('Channel closed');
    this.waiting?.reject(this.failure);
    this.waiting = undefined;
    this.messages = [];
  }
  close() {
    this.end();
    this.stream.abort(this.failure!);
  }
}
export * from './routes.js';

export * from './relay.js';
export * from './admission.js';
export * from './proxy.js';
