import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapEvent, mapFrame } from '../../packages/api/src/events';
import type { SwiftnestEvent } from '@swiftnest/api';
import { chatReducer, emptyChat } from '../src/chat';

const frames = JSON.parse(readFileSync(new URL('../../packages/api/test/fixtures/chat.json', import.meta.url), 'utf8')) as Parameters<typeof mapFrame>[1][];
const tools = JSON.parse(readFileSync(new URL('../../packages/api/test/fixtures/tools-and-error.json', import.meta.url), 'utf8')) as Parameters<typeof mapEvent>[1][];
describe('chat transcript reducer', () => {
  it('renders the recorded kernel stream in place and replaces it with the authoritative final', () => {
    let state = emptyChat();
    let key: string | undefined;
    for (const frame of frames) for (const value of mapFrame('chat', frame)) {
      state = chatReducer(state, value);
      if (value.type === 'assistant-delta' || value.type === 'assistant-message') {
        const row = state.rows.find(r => r.kind === 'message' && r.role === 'assistant');
        expect(row?.id).toBe(key ?? row?.id); key = row?.id;
        if (value.type === 'assistant-delta') expect(state.waiting).toBe(true);
      }
    }
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({ role: 'user', text: 'hi' });
    expect(state.rows[1]).toMatchObject({ role: 'assistant', text: 'Hello from Swiftnest.', final: true });
    expect(state.waiting).toBe(false);
    for (const frame of frames) for (const value of mapFrame('chat', frame)) state = chatReducer(state, value);
    expect(state.rows.filter(r => r.kind === 'message' && r.final)).toHaveLength(2);
    expect(state.waiting).toBe(false);
  });
  it('folds tool calls/results into one row per turn and shows model errors inline', () => {
    const state = tools.flatMap(value => mapEvent('chat', value)).reduce(chatReducer, emptyChat());
    expect(state.rows).toEqual([
      expect.objectContaining({ kind: 'tools', finished: true, calls: { 'call-1': { name: 'read_file', arguments: '{"path":"README.md"}', text: 'file missing', isError: true } } }),
      expect.objectContaining({ kind: 'error', text: 'Model unavailable' }),
    ]);
    expect(state.waiting).toBe(false);
  });
  it('discards abandoned attempts, ignores duplicate/outdated deltas, and keeps final messages authoritative', () => {
    let state = emptyChat();
    const send = (value: SwiftnestEvent) => { state = chatReducer(state, value); };
    send({ sessionId: 'chat', type: 'assistant-start', attemptId: 'a' });
    for (const index of [1, 1, 0]) send({ sessionId: 'chat', type: 'assistant-delta', attemptId: 'a', index, text: 'partial' });
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
    const state = chatReducer(chatReducer(emptyChat(), { type: 'waiting' }), { sessionId: 'chat', type: 'future-card', payload: { value: 1 } } as unknown as SwiftnestEvent);
    expect(state.waiting).toBe(true);
    expect(state.rows[0]).toMatchObject({ kind: 'unknown', event: { type: 'future-card' } });
  });
});
