import { isText, localizedError, render, text, type Text } from '@swiftnest/protocol';
import type { RemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import type { ApiWebSocket } from './types.js';

/** randomUUID is secure-context-only; plain LAN HTTP still has getRandomValues. */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What an API failure says: catalog text, or prose from a peer that sent no key. */
type Words = string | Text;
const english = (words: Words | undefined) =>
  words === undefined || typeof words === 'string' ? words : render(words, 'en');
const textOf = (words: Words | undefined) => (isText(words) ? words : undefined);

/** A failure in the App's language, keeping the catalog text so it can be shown in another. */
export class ApiError extends Error {
  readonly hint: string;
  readonly text?: Text;
  readonly hintText?: Text;

  constructor(
    public readonly code: string,
    message: Words,
    hint?: Words,
    public readonly serverCode?: string,
    public readonly httpStatus?: number,
  ) {
    const source = {
      code,
      message: english(message),
      hint: english(hint),
      text: textOf(message),
      hintText: textOf(hint),
    };
    const failure = localizedError(source);
    super(failure.message);
    this.hint = failure.hint;
    this.text = source.text;
    this.hintText = source.hintText;
    this.name = 'ApiError';
  }

  /** A failure body from the server: its catalog text when it sent one, else its prose. */
  static fromServer(code: string, body: ServerFailureBody | undefined, fallback: Text, httpStatus?: number): ApiError {
    const message = isText(body?.text) ? body.text : (body?.message ?? fallback);
    const hint = isText(body?.hintText) ? body.hintText : body?.hint;
    return new ApiError(code, message, hint, body?.code, httpStatus);
  }
}

/** The fields of a failure the server answers with; all optional, since a proxy may answer instead. */
export interface ServerFailureBody {
  code?: string;
  message?: string;
  hint?: string;
  text?: unknown;
  hintText?: unknown;
}

/** Cancellable single-reader inbox. Closing wakes a reader already blocked in next(). */
export class Inbox<T> implements AsyncIterableIterator<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: Error;
  constructor(
    private readonly dispose: () => void = () => {},
    private readonly capacity = Infinity,
  ) {}
  push(item: T): void {
    if (!this.ended) {
      if (this.items.length >= this.capacity) this.items.shift();
      this.items.push(item);
      this.wake?.();
    }
  }
  end(error?: Error): void {
    this.ended = true;
    this.failure = error;
    this.wake?.();
  }
  close(): void {
    this.items = [];
    this.end();
    this.dispose();
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
  async next(): Promise<IteratorResult<T>> {
    if (this.wake) throw new ApiError('concurrent-read', text('subscriptionSupportsOnePendingRead'));
    while (!this.items.length && !this.ended)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      }).finally(() => {
        this.wake = undefined;
      });
    if (this.items.length) return { done: false, value: this.items.shift()! };
    if (this.failure) throw this.failure;
    return { done: true, value: undefined };
  }
  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { done: true, value: undefined };
  }
}

/** One physical socket per paired API Peer; never silently retries a prompt. */
export class Mux {
  private streams = new Map<string, Inbox<unknown>>();
  private closed = false;
  private constructor(private socket: ApiWebSocket) {}
  static async open(socket: ApiWebSocket, timeoutMs: number): Promise<Mux> {
    const mux = new Mux(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new ApiError('timeout', text('apiSocketDidNotOpenTime'))), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
      };
      const fail = (error: Error) => {
        cleanup();
        socket.close();
        reject(error);
      };
      const failed = () => fail(new ApiError('disconnected', text('apiSocketFailedOpen')));
      const opened = () => {
        cleanup();
        resolve();
      };
      socket.addEventListener('message', (e) => mux.receive(e.data));
      socket.addEventListener('close', () =>
        mux.close(new ApiError('disconnected', text('apiSocketClosedReconnectPairingUrl'))),
      );
      socket.addEventListener('error', () => mux.close(new ApiError('disconnected', text('apiSocketFailed'))));
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
    });
    return mux;
  }
  stream(endpoint: string, args: unknown): Inbox<unknown> {
    if (this.closed) throw new ApiError('disconnected', text('apiSocketClosed'));
    const streamId = randomId();
    const inbox = new Inbox<unknown>(() => {
      if (this.streams.delete(streamId) && !this.closed) this.socket.send(JSON.stringify({ type: 'cancel', streamId }));
    });
    this.streams.set(streamId, inbox);
    try {
      this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    } catch (error) {
      this.streams.delete(streamId);
      throw error;
    }
    return inbox;
  }
  private receive(data: unknown): void {
    try {
      if (typeof data !== 'string') throw new Error('Expected a text frame');
      const frame = JSON.parse(data) as RemoteStreamServerMessage;
      if (!frame || typeof frame.streamId !== 'string' || !['item', 'end', 'error'].includes(frame.type))
        throw new Error('Invalid mux frame');
      const inbox = this.streams.get(frame.streamId);
      if (!inbox) return;
      if (frame.type === 'item') inbox.push(frame.value);
      else {
        this.streams.delete(frame.streamId);
        inbox.end(frame.type === 'error' ? new ApiError(frame.error.code, frame.error.message) : undefined);
      }
    } catch {
      this.close(new ApiError('protocol-error', text('invalidApiStreamFrame')));
    }
  }
  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const inbox of this.streams.values()) inbox.end(error);
    this.streams.clear();
    this.socket.close(1000, 'client closed');
  }
}
