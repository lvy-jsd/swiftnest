import type { RemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import type { ApiWebSocket } from './types.js';

/** randomUUID is secure-context-only; plain LAN HTTP still has getRandomValues. */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ApiError'; }
}

/** Cancellable single-reader inbox. Closing wakes a reader already blocked in next(). */
export class Inbox<T> implements AsyncIterableIterator<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: Error;
  constructor(private readonly dispose: () => void = () => {}, private readonly capacity = Infinity) {}
  push(item: T): void { if (!this.ended) { if (this.items.length >= this.capacity) this.items.shift(); this.items.push(item); this.wake?.(); } }
  end(error?: Error): void { this.ended = true; this.failure = error; this.wake?.(); }
  close(): void { this.items = []; this.end(); this.dispose(); }
  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
  async next(): Promise<IteratorResult<T>> {
    if (this.wake) throw new ApiError('concurrent-read', 'A subscription supports one pending read');
    while (!this.items.length && !this.ended) await new Promise<void>(resolve => { this.wake = resolve; }).finally(() => { this.wake = undefined; });
    if (this.items.length) return { done: false, value: this.items.shift()! };
    if (this.failure) throw this.failure;
    return { done: true, value: undefined };
  }
  async return(): Promise<IteratorResult<T>> { this.close(); return { done: true, value: undefined }; }
}

/** One physical socket per paired API Peer; never silently retries a prompt. */
export class Mux {
  private streams = new Map<string, Inbox<unknown>>();
  private closed = false;
  private constructor(private socket: ApiWebSocket) {}
  static async open(socket: ApiWebSocket, timeoutMs: number): Promise<Mux> {
    const mux = new Mux(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new ApiError('timeout', 'API socket did not open in time')), timeoutMs);
      const cleanup = () => { clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); };
      const fail = (error: Error) => { cleanup(); socket.close(); reject(error); };
      const failed = () => fail(new ApiError('disconnected', 'API socket failed to open'));
      const opened = () => { cleanup(); resolve(); };
      socket.addEventListener('message', e => mux.receive(e.data));
      socket.addEventListener('close', () => mux.close(new ApiError('disconnected', 'API socket closed; reconnect with the pairing URL')));
      socket.addEventListener('error', () => mux.close(new ApiError('disconnected', 'API socket failed')));
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
    });
    return mux;
  }
  stream(endpoint: string, args: unknown): Inbox<unknown> {
    if (this.closed) throw new ApiError('disconnected', 'API socket is closed');
    const streamId = randomId();
    const inbox = new Inbox<unknown>(() => {
      if (this.streams.delete(streamId) && !this.closed) this.socket.send(JSON.stringify({ type: 'cancel', streamId }));
    });
    this.streams.set(streamId, inbox);
    try { this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })); }
    catch (error) { this.streams.delete(streamId); throw error; }
    return inbox;
  }
  private receive(data: unknown): void {
    try {
      if (typeof data !== 'string') throw new Error('Expected a text frame');
      const frame = JSON.parse(data) as RemoteStreamServerMessage;
      if (!frame || typeof frame.streamId !== 'string' || !['item', 'end', 'error'].includes(frame.type)) throw new Error('Invalid mux frame');
      const inbox = this.streams.get(frame.streamId);
      if (!inbox) return;
      if (frame.type === 'item') inbox.push(frame.value);
      else {
        this.streams.delete(frame.streamId);
        inbox.end(frame.type === 'error' ? new ApiError(frame.error.code, frame.error.message) : undefined);
      }
    } catch { this.close(new ApiError('protocol-error', 'Invalid API stream frame')); }
  }
  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const inbox of this.streams.values()) inbox.end(error);
    this.streams.clear();
    this.socket.close(1000, 'client closed');
  }
}
