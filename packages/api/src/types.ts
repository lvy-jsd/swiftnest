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
export interface CreatedSession { sessionId: string }
export interface CreateSessionOptions { cwd?: string }
export interface MessageReceipt { requestId: string; accepted: true }
export interface Question {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export interface QuestionAnswer { answers: { id: string; selected: string[]; custom?: string }[] }
export type ApprovalAnswer = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

interface EventBase { sessionId: string; seq?: number; time?: number }
export type SwiftnestEvent = EventBase & (
  | { type: 'user-message'; messageId: string; text: string; requestId?: string }
  | { type: 'assistant-start'; attemptId: string }
  | { type: 'assistant-end'; attemptId: string; outcome: 'committed' | 'abandoned'; messageSeq?: number }
  | { type: 'assistant-delta'; attemptId: string; index: number; text: string }
  | { type: 'assistant-message'; messageId: string; text: string }
  | { type: 'tool-start'; callId: string; name: string; arguments: string }
  | { type: 'tool-result'; callId: string; text: string; isError: boolean }
  | { type: 'turn-end'; turn: number; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'approval-request'; requestId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'question-request'; requestId: string; questions: Question[]; callId?: string }
  | { type: 'interaction-cancelled'; requestId: string }
);

/** One consumer; breaking a for-await loop also cancels the Host stream. */
export interface Subscription extends AsyncIterableIterator<SwiftnestEvent> { close(): void }

export interface SocketEventMap {
  open: object;
  close: object;
  error: object;
  message: { readonly data: unknown };
}
/** Structural subset supported by browser WebSocket and the Node `ws` package. */
export interface ApiWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void, options?: { once?: boolean }): void;
  removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
}
export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Required in Node: e.g. (url, {headers}) => new WebSocket(url, {headers}) using `ws`. */
  createWebSocket?: (url: string, options: { headers: Readonly<Record<string, string>> }) => ApiWebSocket;
  /** Defaults to manual outside a document, browser otherwise. */
  cookieMode?: 'manual' | 'browser';
  /** Pairing, socket readiness and each unary call; default 15 seconds. */
  timeoutMs?: number;
}
