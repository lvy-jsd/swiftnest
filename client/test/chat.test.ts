import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapEvent, mapFrame } from '../../packages/api/src/events';
import type { SwiftnestEvent } from '@swiftnest/api';
import { chatReducer, emptyChat } from '../src/chat';

const frames = JSON.parse(
  readFileSync(new URL('../../packages/api/test/fixtures/chat.json', import.meta.url), 'utf8'),
) as Parameters<typeof mapFrame>[1][];
const tools = JSON.parse(
  readFileSync(new URL('../../packages/api/test/fixtures/tools-and-error.json', import.meta.url), 'utf8'),
) as Parameters<typeof mapEvent>[1][];
describe('chat transcript reducer', () => {
  it('renders the recorded kernel stream in place and replaces it with the authoritative final', () => {
    let state = emptyChat();
    let key: string | undefined;
    for (const frame of frames)
      for (const value of mapFrame('chat', frame)) {
        state = chatReducer(state, value);
        if (value.type === 'assistant-delta' || value.type === 'assistant-message') {
          const row = state.rows.find((r) => r.kind === 'message' && r.role === 'assistant');
          expect(row?.id).toBe(key ?? row?.id);
          key = row?.id;
          if (value.type === 'assistant-delta') expect(state.waiting).toBe(true);
        }
      }
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({ role: 'user', text: 'hi' });
    expect(state.rows[1]).toMatchObject({ role: 'assistant', text: 'Hello from Swiftnest.', final: true });
    expect(state.waiting).toBe(false);
    for (const frame of frames) for (const value of mapFrame('chat', frame)) state = chatReducer(state, value);
    expect(state.rows.filter((r) => r.kind === 'message' && r.final)).toHaveLength(2);
    expect(state.waiting).toBe(false);
  });
  it('folds tool calls/results into one row per turn and shows model errors inline', () => {
    const state = tools.flatMap((value) => mapEvent('chat', value)).reduce(chatReducer, emptyChat());
    expect(state.rows).toEqual([
      expect.objectContaining({
        kind: 'tools',
        finished: true,
        calls: {
          'call-1': { name: 'read_file', arguments: '{"path":"README.md"}', text: 'file missing', isError: true },
        },
      }),
      expect.objectContaining({ kind: 'error', text: 'Model unavailable' }),
    ]);
    expect(state.waiting).toBe(false);
  });
  it('discards abandoned attempts, ignores duplicate/outdated deltas, and keeps final messages authoritative', () => {
    let state = emptyChat();
    const send = (value: SwiftnestEvent) => {
      state = chatReducer(state, value);
    };
    send({ sessionId: 'chat', type: 'assistant-start', attemptId: 'a' });
    for (const index of [1, 1, 0])
      send({ sessionId: 'chat', type: 'assistant-delta', attemptId: 'a', index, text: 'partial' });
    expect(state.rows[0]).toMatchObject({ text: 'partial' });
    send({ sessionId: 'chat', type: 'assistant-end', attemptId: 'a', outcome: 'abandoned' });
    expect(state.rows).toEqual([]);
    send({ sessionId: 'chat', type: 'assistant-start', attemptId: 'b' });
    send({ sessionId: 'chat', type: 'assistant-end', attemptId: 'b', outcome: 'committed', messageSeq: 4 });
    send({ sessionId: 'chat', type: 'assistant-message', messageId: 'final', text: 'correct', seq: 4 });
    send({ sessionId: 'chat', type: 'assistant-delta', attemptId: 'b', index: 9, text: 'wrong' });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ text: 'correct', final: true });
  });
  it('preserves unknown events as generic cards and shows waiting immediately after send', () => {
    const state = chatReducer(chatReducer(emptyChat(), { type: 'waiting' }), {
      sessionId: 'chat',
      type: 'future-card',
      payload: { value: 1 },
    } as unknown as SwiftnestEvent);
    expect(state.waiting).toBe(true);
    expect(state.rows[0]).toMatchObject({ kind: 'unknown', event: { type: 'future-card' } });
  });
});

it('replays sent photos and generated media together without duplicating transcript rows', () => {
  const images = [{ attachmentId: 'sha256:photo', mediaType: 'image/png', name: 'sent.png' }];
  const attachments = [{ path: 'media/chart.png', name: 'chart.png' }];
  const records: { event: Parameters<typeof mapEvent>[1] }[] = [
    {
      event: {
        type: 'user/message',
        seq: 1,
        time: 100,
        data: { id: 'photo', source: { kind: 'user' }, content: [{ type: 'image', attachment: images[0]! }] },
      },
    },
    {
      event: {
        type: 'tool/call',
        seq: 2,
        time: 101,
        data: { callId: 'chart', name: 'chart_render', arguments: '{}' },
      },
    },
    {
      event: {
        type: 'tool/result',
        seq: 3,
        time: 102,
        data: { message: { toolCallId: 'chart', content: 'done' }, meta: { mediaFiles: attachments } },
      },
    },
    { event: { type: 'turn/end', seq: 4, time: 103, data: { turn: 1, reason: { kind: 'completed' } } } },
  ];
  const snapshot = structuredClone(frames.find((frame) => frame.type === 'snapshot')!);
  if (snapshot.type !== 'snapshot') throw new Error('Missing snapshot');
  const events = mapFrame('chat', {
    ...snapshot,
    records: records.map((entry) => ({ type: 'event' as const, ...entry })),
  });
  const state = [...events, ...events].reduce(chatReducer, emptyChat());
  expect(state.rows).toHaveLength(2);
  expect(state.rows[0]).toMatchObject({ kind: 'message', text: '', images });
  expect(state.rows[1]).toMatchObject({
    kind: 'tools',
    finished: true,
    calls: { chart: { attachments, text: 'done' } },
  });
  expect(state.waiting).toBe(false);
});

it('keeps chat approval references without a separate decision state', () => {
  const event = {
    sessionId: 'chat',
    type: 'approval-request',
    requestId: 'risk',
    toolName: 'tools_load',
    reason: 'Load high-risk tool?',
  } as const;
  const pending = chatReducer(emptyChat(), event);
  expect(pending.rows).toEqual([
    {
      kind: 'approval',
      id: 'approval:risk',
      requestId: 'risk',
      toolName: 'tools_load',
    },
  ]);
  expect(chatReducer(pending, event).rows).toHaveLength(1);
  const cancelled = chatReducer(pending, { sessionId: 'chat', type: 'interaction-cancelled', requestId: 'risk' });
  expect(cancelled.rows).toEqual(pending.rows);
  expect(pending.rows[0]).not.toHaveProperty('settled');
});
