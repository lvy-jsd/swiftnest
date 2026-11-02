import type { SwiftnestEvent } from '@swiftnest/api';

export type ChatRow =
  | {
      kind: 'message';
      id: string;
      role: 'user' | 'assistant';
      text: string;
      attemptId?: string;
      seq?: number;
      final?: boolean;
      index?: number;
      messageSeq?: number;
    }
  | {
      kind: 'tools';
      id: string;
      calls: Record<string, { name?: string; arguments?: string; text?: string; isError?: boolean }>;
      finished: boolean;
    }
  | { kind: 'error'; id: string; text: string; code?: string }
  | { kind: 'unknown'; id: string; event: unknown };
export interface ChatState {
  rows: ChatRow[];
  waiting: boolean;
  activeAttempt?: string;
  toolsId?: string;
  seen: Set<string>;
}
export const emptyChat = (): ChatState => ({ rows: [], waiting: false, seen: new Set() });

/** Durable messages are authoritative; attempts keep a stable row key while text grows. */
export function chatReducer(state: ChatState, event: SwiftnestEvent | { type: 'waiting' }): ChatState {
  if (event.type === 'waiting') return { ...state, waiting: true };
  const key = event.seq === undefined ? undefined : `${event.type}:${event.seq}`;
  if (key && state.seen.has(key)) return state;
  const next = { ...state, rows: [...state.rows], seen: new Set(state.seen) };
  if (key) next.seen.add(key);
  const attemptIndex = (id: string) => next.rows.findIndex((r) => r.kind === 'message' && r.attemptId === id);
  switch (event.type) {
    case 'user-message':
      if (!next.rows.some((r) => r.id === event.messageId))
        next.rows.push({
          kind: 'message',
          id: event.messageId,
          role: 'user',
          text: event.text,
          seq: event.seq,
          final: true,
        });
      next.waiting = true;
      break;
    case 'assistant-start': {
      const existing = next.rows[attemptIndex(event.attemptId)];
      if (existing?.kind === 'message' && existing.final) return state;
      next.activeAttempt = event.attemptId;
      next.waiting = true;
      if (attemptIndex(event.attemptId) < 0)
        next.rows.push({
          kind: 'message',
          id: `attempt:${event.attemptId}`,
          attemptId: event.attemptId,
          role: 'assistant',
          text: '',
          index: -1,
        });
      break;
    }
    case 'assistant-delta': {
      let index = attemptIndex(event.attemptId);
      if (index < 0) {
        next.rows.push({
          kind: 'message',
          id: `attempt:${event.attemptId}`,
          role: 'assistant',
          attemptId: event.attemptId,
          text: '',
          index: -1,
        });
        index = next.rows.length - 1;
      }
      const row = next.rows[index]!;
      if (row.kind === 'message' && !row.final && event.index > (row.index ?? -1))
        next.rows[index] = { ...row, text: row.text + event.text, index: event.index };
      if (row.kind === 'message' && !row.final) next.waiting = true;
      break;
    }
    case 'assistant-message': {
      const existing = next.rows.findIndex(
        (r) =>
          r.kind === 'message' && (r.id === event.messageId || (event.seq !== undefined && r.messageSeq === event.seq)),
      );
      const active = next.activeAttempt ? attemptIndex(next.activeAttempt) : -1;
      const index = existing >= 0 ? existing : active;
      const previous = index >= 0 ? next.rows[index] : undefined;
      const row: ChatRow = {
        kind: 'message',
        id: previous?.id ?? event.messageId,
        role: 'assistant',
        text: event.text,
        seq: event.seq,
        final: true,
        ...(previous?.kind === 'message' && previous.attemptId ? { attemptId: previous.attemptId } : {}),
      };
      if (index >= 0) next.rows[index] = row;
      else next.rows.push(row);
      break;
    }
    case 'assistant-end': {
      const index = attemptIndex(event.attemptId);
      if (event.outcome === 'abandoned')
        next.rows = next.rows.filter((r) => !(r.kind === 'message' && r.attemptId === event.attemptId && !r.final));
      else if (index >= 0) {
        const row = next.rows[index]!;
        if (row.kind === 'message') next.rows[index] = { ...row, messageSeq: event.messageSeq };
      }
      if (next.activeAttempt === event.attemptId) next.activeAttempt = undefined;
      break;
    }
    case 'tool-start':
    case 'tool-result': {
      const index = next.toolsId ? next.rows.findIndex((r) => r.id === next.toolsId) : -1;
      const previous = index >= 0 ? next.rows[index] : undefined;
      const row: Extract<ChatRow, { kind: 'tools' }> =
        previous?.kind === 'tools'
          ? { ...previous, calls: { ...previous.calls } }
          : { kind: 'tools', id: `tools:${event.callId}`, calls: {}, finished: false };
      row.calls[event.callId] = {
        ...row.calls[event.callId],
        ...(event.type === 'tool-start'
          ? { name: event.name, arguments: event.arguments }
          : { text: event.text, isError: event.isError }),
      };
      if (index >= 0) next.rows[index] = row;
      else next.rows.push(row);
      next.toolsId = row.id;
      next.waiting = true;
      break;
    }
    case 'turn-end':
      next.rows = next.rows
        .filter((r) => !(r.kind === 'message' && !r.final && r.attemptId))
        .map((r) => (r.kind === 'tools' && r.id === next.toolsId ? { ...r, finished: true } : r));
      next.waiting = false;
      next.activeAttempt = undefined;
      next.toolsId = undefined;
      break;
    case 'error':
      next.rows.push({ kind: 'error', id: `error:${next.rows.length}`, text: event.message, code: event.code });
      next.waiting = false;
      break;
    default:
      next.rows.push({ kind: 'unknown', id: `event:${next.rows.length}`, event });
  }
  return next;
}
