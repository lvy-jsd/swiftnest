import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types';
import { mapEvent, mapFrame } from '../src/events.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/chat.json', import.meta.url), 'utf8')) as SessionFollowFrame[];
const tools = JSON.parse(readFileSync(new URL('./fixtures/tools-and-error.json', import.meta.url), 'utf8')) as SessionWireEvent[];
describe('DSH 0.2.1-rc.5 → Swiftnest events', () => {
  it('maps recorded real-kernel chat frames, with deltas separate from the final message', () => {
    const events = fixtures.flatMap(f => mapFrame('chat', f));
    expect(events.find(e => e.type === 'user-message')).toMatchObject({ text: 'hi', sessionId: 'chat', requestId: expect.any(String), messageId: expect.any(String) });
    expect(events.filter(e => e.type === 'assistant-delta').map(e => e.text)).toEqual(['Hello ', 'from ', 'Swiftnest.']);
    expect(events.filter(e => e.type === 'assistant-message')).toEqual([expect.objectContaining({ text: 'Hello from Swiftnest.', messageId: expect.any(String), seq: expect.any(Number) })]);
    expect(events.find(e => e.type === 'assistant-end')).toMatchObject({ outcome: 'committed', messageSeq: events.find(e => e.type === 'assistant-message')?.seq });
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
  });
  it('maps tool identity, raw arguments, results and a failed turn', () => {
    expect(tools.flatMap(e => mapEvent('chat', e))).toEqual([
      { sessionId: 'chat', seq: 1, time: 100, type: 'tool-start', callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
      { sessionId: 'chat', seq: 2, time: 101, type: 'tool-result', callId: 'call-1', text: 'file missing', isError: true },
      { sessionId: 'chat', seq: 3, time: 102, type: 'error', code: 'PI_AI_ERROR', message: 'Model unavailable' },
      { sessionId: 'chat', seq: 3, time: 102, type: 'turn-end', turn: 1, reason: 'error' },
    ]);
  });
  it('replays compact text from an in-progress opening snapshot without reasoning/tool data', () => {
    const snapshot = structuredClone(fixtures.find(f => f.type === 'snapshot')!);
    if (snapshot.type !== 'snapshot') throw new Error('Missing snapshot');
    snapshot.assistantStream = { revision: 4, activeAttempt: {
      attemptId: 'attempt' as never, startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 4,
      stream: [{ type: 'text-chunks', index: 0, time0: 100, dt: [0, 1], texts: ['Hello ', 'from '] }, { type: 'reasoning-chunks', texts: ['hidden'] }, { type: 'chunk', time: 102, chunk: { type: 'text-delta', index: 0, text: 'Swiftnest.' } }],
    } };
    expect(mapFrame('chat', snapshot)).toEqual([{ sessionId: 'chat', type: 'assistant-start', attemptId: 'attempt' }, { sessionId: 'chat', type: 'assistant-delta', attemptId: 'attempt', index: 3, text: 'Hello from Swiftnest.' }]);
  });
  it('ignores unknown bookkeeping and non-text chunks, while preserving abandoned attempts', () => {
    expect(mapFrame('chat', { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a' as never, revision: 2, index: 1, outcome: { kind: 'abandoned' } } })).toEqual([{ sessionId: 'chat', type: 'assistant-end', attemptId: 'a', outcome: 'abandoned' }]);
    expect(mapEvent('chat', { type: 'future/metadata', seq: 1, time: 0, data: null })).toEqual([]);
    expect(mapFrame('chat', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'hidden' } } })).toEqual([]);
  });
});
