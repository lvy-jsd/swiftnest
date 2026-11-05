import { expect, it } from 'vitest';
import type { SwiftnestEvent } from '@swiftnest/api';
import { chatReducer, emptyChat } from '../src/chat';
import { chatTimeline, messageTime, toolSeconds } from '../src/chatPresentation';

it('keeps durable timestamps through streaming, replay and a language-independent presentation', () => {
  const events: SwiftnestEvent[] = [
    { sessionId: 's', type: 'user-message', messageId: 'u', text: 'hello', time: 1000 },
    { sessionId: 's', type: 'assistant-start', attemptId: 'a' },
    { sessionId: 's', type: 'assistant-delta', attemptId: 'a', index: 0, text: 'hello', time: 2000 },
    { sessionId: 's', type: 'assistant-message', messageId: 'm', text: 'hello', time: 3000 },
    { sessionId: 's', type: 'turn-end', turn: 1, reason: 'stop', time: 4000 },
  ];
  const timeline = events.reduce(chatTimeline, {});
  const state = events.reduce(chatReducer, emptyChat());
  const messages = state.rows.filter((row) => row.kind === 'message');
  expect(messages.map((row) => messageTime(row, timeline))).toEqual([1000, 2000]);
  expect(events.reduce(chatTimeline, timeline)).toEqual(timeline);
  const replay = chatReducer(emptyChat(), events[3]!);
  expect(messageTime(replay.rows[0] as (typeof messages)[number], timeline)).toBe(3000);
  expect(chatTimeline(timeline, { ...events[0]!, time: NaN })).toBe(timeline);
  expect(chatTimeline(timeline, { ...events[0]!, time: 1e20 })).toBe(timeline);
});

it('reports elapsed tool time from real start/result pairs and leaves missing timing unknown', () => {
  const events: SwiftnestEvent[] = [
    { sessionId: 's', type: 'tool-start', callId: 'one', name: 'read', arguments: '{}', time: 1000 },
    { sessionId: 's', type: 'tool-result', callId: 'one', text: 'ok', isError: false, time: 22000 },
    { sessionId: 's', type: 'tool-start', callId: 'two', name: 'read', arguments: '{}', time: 23000 },
    { sessionId: 's', type: 'tool-result', callId: 'two', text: 'ok', isError: false, time: 43000 },
    { sessionId: 's', type: 'turn-end', turn: 1, reason: 'stop', time: 80000 },
  ];
  const state = events.reduce(chatReducer, emptyChat());
  const row = state.rows.find((item) => item.kind === 'tools')!;
  expect(toolSeconds(row, events.reduce(chatTimeline, {}))).toBe(42);
  expect(toolSeconds(row, {})).toBeUndefined();
  expect(toolSeconds(row, events.slice(1).reduce(chatTimeline, {}))).toBeUndefined();
});
