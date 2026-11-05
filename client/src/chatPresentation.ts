import type { SwiftnestEvent } from '@swiftnest/api';
import type { ChatRow } from './chat';

export type ChatTimeline = Record<string, { start?: number; end?: number }>;

/** Presentation metadata only: the session reducer, replay and delivery stay untouched. */
export function chatTimeline(timeline: ChatTimeline, event: SwiftnestEvent): ChatTimeline {
  if (event.time === undefined || !Number.isFinite(event.time) || Math.abs(event.time) > 8.64e15) return timeline;
  let key: string;
  if (event.type === 'user-message' || event.type === 'assistant-message') key = event.messageId;
  else if (event.type === 'assistant-delta' || event.type === 'assistant-start') key = `attempt:${event.attemptId}`;
  else if (event.type === 'tool-start' || event.type === 'tool-result') key = `call:${event.callId}`;
  else return timeline;
  const previous = timeline[key];
  if (event.type === 'tool-start' || event.type === 'tool-result') {
    return {
      ...timeline,
      [key]: {
        start: event.type === 'tool-start' ? Math.min(previous?.start ?? event.time, event.time) : previous?.start,
        end: event.type === 'tool-result' ? Math.max(previous?.end ?? event.time, event.time) : previous?.end,
      },
    };
  }
  return {
    ...timeline,
    [key]: {
      start: Math.min(previous?.start ?? event.time, event.time),
      end: Math.max(previous?.end ?? event.time, event.time),
    },
  };
}

export function messageTime(row: Extract<ChatRow, { kind: 'message' }>, timeline: ChatTimeline) {
  return (timeline[row.id] ?? (row.attemptId ? timeline[`attempt:${row.attemptId}`] : undefined))?.start;
}

export function toolSeconds(row: Extract<ChatRow, { kind: 'tools' }>, timeline: ChatTimeline) {
  const times = Object.keys(row.calls).map((id) => timeline[`call:${id}`]);
  if (!times.length || times.some((time) => time?.start === undefined || time.end === undefined)) return undefined;
  return Math.max(
    0,
    Math.round((Math.max(...times.map((t) => t!.end!)) - Math.min(...times.map((t) => t!.start!))) / 1000),
  );
}
