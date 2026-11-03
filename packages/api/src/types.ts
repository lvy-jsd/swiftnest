/** Swiftnest-owned types. No DSH types cross this public boundary. */
export interface Health {
  ok: true;
  swiftnest: string;
  dsh: string;
  model: { configured: boolean; reachable: boolean | null };
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  title?: string;
  cwd?: string;
}
export interface CreatedSession {
  sessionId: string;
}
export interface CreateSessionOptions {
  cwd?: string;
}
/** An image the App sends with a message: canonical base64 bytes of a PNG, JPEG, WebP or GIF. */
export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
  name?: string;
}
/** An image the server stored with a message; read its bytes with `readImage`. */
export interface MessageImage {
  attachmentId: string;
  mediaType: string;
  width?: number;
  height?: number;
  name?: string;
}
export interface MessageReceipt {
  requestId: string;
  accepted: true;
}
export interface Question {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export interface QuestionAnswer {
  answers: { id: string; selected: string[]; custom?: string }[];
}
export type ApprovalAnswer = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

interface EventBase {
  sessionId: string;
  seq?: number;
  time?: number;
}
export type SwiftnestEvent = EventBase &
  (
    | { type: 'user-message'; messageId: string; text: string; images?: MessageImage[]; requestId?: string }
    | { type: 'assistant-start'; attemptId: string }
    | { type: 'assistant-end'; attemptId: string; outcome: 'committed' | 'abandoned'; messageSeq?: number }
    | { type: 'assistant-delta'; attemptId: string; index: number; text: string }
    | { type: 'assistant-message'; messageId: string; text: string }
    | { type: 'tool-start'; callId: string; name: string; arguments: string }
    | { type: 'tool-result'; callId: string; text: string; isError: boolean }
    | { type: 'turn-end'; turn: number; reason: string }
    | { type: 'error'; code: string; message: string }
    | {
        type: 'approval-request';
        requestId: string;
        toolName: string;
        callId?: string;
        /** The asker's reason, for the audit log. */
        reason?: string;
        /** The same reason written for people, per language (`en`, `zh-CN`), when the asker supplies it. */
        displayReason?: DisplayReason;
      }
    | { type: 'question-request'; requestId: string; questions: Question[]; callId?: string }
    | { type: 'interaction-cancelled'; requestId: string }
  );

/** One consumer; breaking a for-await loop also cancels the Host stream. */
export interface Subscription extends AsyncIterableIterator<SwiftnestEvent> {
  close(): void;
}

export interface SocketEventMap {
  open: object;
  close: object;
  error: object;
  message: { readonly data: unknown };
}
/** Structural subset supported by browser WebSocket and the Node `ws` package. */
export interface ApiWebSocket {
  readonly readyState: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEventMap>(
    type: K,
    listener: (event: SocketEventMap[K]) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
}
export interface ClientOptions {
  /** Public key/address pin only; credentials stay in their existing private store. */
  channelPairingStore?: {
    load(root: string): Promise<import('./channel.js').ChannelPairing | undefined>;
    save(root: string, pairing: import('./channel.js').ChannelPairing): Promise<void>;
  };
  /** LAN browser owner cookie, retained in memory across an agent restart. */
  channelBrowserCookie?: { load(root: string): string | undefined; save(root: string, cookie: string): void };

  /** Paired device this native App connection belongs to. Omit for the server's web App.
   * Owner-reported context hint; does not grant device permissions. */
  deviceSlug?: string;
  fetch?: typeof globalThis.fetch;
  /** Required in Node: e.g. (url, {headers}) => new WebSocket(url, {headers}) using `ws`. */
  createWebSocket?: (url: string, options: { headers: Readonly<Record<string, string>> }) => ApiWebSocket;
  /** Defaults to manual outside a document, browser otherwise. */
  cookieMode?: 'manual' | 'browser';
  /** App transport handoff: defer socket recovery until the rotated credential has been saved. */
  onNativeCredentialRotation?: (active: boolean) => void;
  nativeDevice?: { name: string; kind: 'desktop' | 'android' };
  /** Private native credential storage, keyed by the exact server root. Never use URL or Web storage. */
  nativePairingStore?: {
    load(root: string): Promise<string | undefined>;
    save(root: string, credential: string | undefined): Promise<void>;
  };
  /** Pairing, socket readiness and each unary call; default 15 seconds. */
  timeoutMs?: number;
}

/** Approval reason copy per language, as DSH approval requests carry it. */
export type DisplayReason = { en: string } & Partial<Record<string, string>>;
