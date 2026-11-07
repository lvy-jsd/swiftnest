import { afterEach, expect, it, vi } from 'vitest';
import type { SwiftnestClient, SwiftnestEvent } from '@swiftnest/api';
import { Inbox } from '../../packages/api/src/transport';
import { SessionCache } from '../src/sessionCache';

const callbacks = () => ({ event: vi.fn(), failed: vi.fn() });
function setup(limit?: number) {
  const streams = new Map<string, Inbox<SwiftnestEvent>>();
  const follow = vi.fn(async (id: string, options: { signal: AbortSignal }) => {
    const stream = new Inbox<SwiftnestEvent>();
    options.signal.addEventListener('abort', () => stream.close(), { once: true });
    streams.set(id, stream);
    return stream;
  });
  return { cache: new SessionCache(limit), client: { follow } as unknown as SwiftnestClient, follow, streams };
}
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
afterEach(() => vi.useRealTimers());

it('switches across twenty sessions synchronously without another follow or history replay', async () => {
  vi.useFakeTimers();
  const { cache, client, follow, streams } = setup();
  const updates = callbacks();
  for (let n = 0; n < 20; n++) {
    const id = `chat-${n}`;
    cache.follow(id, client, updates);
    await settle();
    streams.get(id)!.push({ type: 'user-message', sessionId: id, messageId: id, text: id, seq: 1, time: 100 });
  }
  await settle();
  const start = performance.now();
  for (let n = 0; n < 20; n++) {
    const id = `chat-${n}`;
    const before = cache.getSnapshot(id);
    cache.follow(id, client, updates);
    expect(cache.getSnapshot(id)).toBe(before);
    expect(before.state.rows).toMatchObject([{ id, text: id }]);
    expect(before.timeline[id]).toEqual({ start: 100, end: 100 });
    expect(before.ready).toBe(true);
  }
  expect(performance.now() - start).toBeLessThan(100);
  expect(follow).toHaveBeenCalledTimes(20);
  cache.clear();
});

it('keeps hidden streaming attempts and tool groups live, with stable row identities', async () => {
  vi.useFakeTimers();
  const { cache, client, streams } = setup();
  const listener = vi.fn();
  const unsubscribe = cache.subscribe('a', listener);
  cache.follow('a', client, callbacks());
  await settle();
  const stream = streams.get('a')!;
  stream.push({ type: 'assistant-start', sessionId: 'a', attemptId: 'attempt' });
  stream.push({ type: 'assistant-delta', sessionId: 'a', attemptId: 'attempt', index: 0, text: 'Hello' });
  stream.push({ type: 'tool-start', sessionId: 'a', callId: 'tool', name: 'read', arguments: '{}', seq: 1 });
  await settle();
  unsubscribe();
  cache.follow('b', client, callbacks());
  await settle();
  stream.push({ type: 'assistant-delta', sessionId: 'a', attemptId: 'attempt', index: 1, text: ' world' });
  stream.push({ type: 'tool-result', sessionId: 'a', callId: 'tool', text: 'done', isError: false, seq: 2 });
  stream.push({ type: 'assistant-message', sessionId: 'a', messageId: 'reply', text: 'Hello world', seq: 3 });
  stream.push({ type: 'turn-end', sessionId: 'a', turn: 1, reason: 'completed', seq: 4 });
  await settle();
  expect(cache.getSnapshot('a').state).toMatchObject({
    waiting: false,
    rows: [
      { id: 'attempt:attempt', text: 'Hello world', final: true },
      { kind: 'tools', finished: true, calls: { tool: { name: 'read', text: 'done' } } },
    ],
  });
  cache.clear();
});

it('evicts the least recently visited hidden session and closes its subscription', async () => {
  vi.useFakeTimers();
  const { cache, client, streams, follow } = setup(2);
  cache.follow('a', client, callbacks());
  cache.follow('b', client, callbacks());
  await settle();
  const closeA = vi.spyOn(streams.get('a')!, 'close');
  const closeB = vi.spyOn(streams.get('b')!, 'close');
  cache.follow('a', client, callbacks());
  cache.follow('c', client, callbacks());
  await settle();
  expect(closeA).not.toHaveBeenCalled();
  expect(closeB).toHaveBeenCalled();
  cache.follow('b', client, callbacks());
  await settle();
  expect(follow).toHaveBeenCalledTimes(4);
  cache.clear();
});

it('does not evict an observed chat and clears state and late events on connection replacement', async () => {
  vi.useFakeTimers();
  const { cache, client, streams } = setup(1);
  const listener = vi.fn();
  const unsubscribe = cache.subscribe('a', listener);
  cache.follow('a', client, callbacks());
  await settle();
  const stream = streams.get('a')!;
  stream.push({ type: 'user-message', sessionId: 'a', messageId: 'secret', text: 'private', seq: 1 });
  await settle();
  cache.follow('b', client, callbacks());
  await settle();
  expect(cache.getSnapshot('a').state.rows).toHaveLength(1);
  cache.clear();
  stream.push({ type: 'user-message', sessionId: 'a', messageId: 'late', text: 'old server', seq: 2 });
  await settle();
  expect(cache.getSnapshot('a')).toMatchObject({ state: { rows: [], waiting: false }, timeline: {}, ready: false });
  expect(listener).toHaveBeenCalled();
  unsubscribe();
  cache.clear();
});
