import { afterEach, expect, it, vi } from 'vitest';
import type { SwiftnestClient, SwiftnestEvent } from '@swiftnest/api';
import { Inbox } from '../../packages/api/src/transport';
import { readyClientAfter, watchChatSession } from '../src/chatSession';

afterEach(() => vi.useRealTimers());
const observer = () => ({ ready: vi.fn(), event: vi.fn(), failed: vi.fn() });
const clientWith = (follow: unknown) => ({ follow }) as SwiftnestClient;

it('re-follows an ended session stream, reports readiness and cancels the pending retry on disposal', async () => {
  vi.useFakeTimers();
  const first = new Inbox<SwiftnestEvent>();
  const second = new Inbox<SwiftnestEvent>();
  const follow = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const updates = observer();
  const stop = watchChatSession(clientWith(follow), 'chat', updates);
  await vi.advanceTimersByTimeAsync(0);
  expect(updates.ready).toHaveBeenLastCalledWith(true);
  const event = {
    type: 'assistant-message',
    sessionId: 'chat',
    messageId: 'reply',
    text: 'old reply',
    seq: 2,
  } as const;
  first.push(event);
  first.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(updates.event).toHaveBeenCalledExactlyOnceWith(event);
  expect(updates.ready).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(follow).toHaveBeenCalledTimes(2);
  expect(updates.ready).toHaveBeenLastCalledWith(true);
  second.end();
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(8000);
  expect(follow).toHaveBeenCalledTimes(2);
  expect(updates.failed).not.toHaveBeenCalled();
});

it('backs off failed openings without repeating the error and recovers on a fresh subscription', async () => {
  vi.useFakeTimers();
  const stream = new Inbox<SwiftnestEvent>();
  const follow = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
  follow.mockResolvedValue(stream);
  const updates = observer();
  const stop = watchChatSession(clientWith(follow), 'chat', updates);
  await vi.advanceTimersByTimeAsync(500);
  expect(follow).toHaveBeenCalledTimes(2);
  expect(updates.failed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(follow).toHaveBeenCalledTimes(3);
  expect(updates.ready).toHaveBeenLastCalledWith(true);
  stop();
  stream.close();
});

it('keeps a newer client ready when a replaced subscription reports a late failure', async () => {
  vi.useFakeTimers();
  const first = new Inbox<SwiftnestEvent>();
  const follow = vi.fn().mockResolvedValueOnce(first);
  const oldClient = clientWith(follow);
  const newClient = clientWith(follow);
  const updates = observer();
  const stop = watchChatSession(oldClient, 'chat', updates);
  await vi.advanceTimersByTimeAsync(0);
  expect(updates.ready).toHaveBeenLastCalledWith(true);
  // A restart swaps the client and disposes the old watcher before its stream ends.
  stop();
  first.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(updates.ready).toHaveBeenLastCalledWith(true);
  // Even if a late callback slips through a pending microtask, identity keeps the new client ready.
  expect(readyClientAfter(newClient, false, oldClient)).toBe(newClient);
  expect(readyClientAfter(newClient, true, newClient)).toBe(newClient);
  expect(readyClientAfter(oldClient, false, oldClient)).toBeUndefined();
});

it('closes a late subscription without publishing readiness or replaying events after disposal', async () => {
  vi.useFakeTimers();
  const stream = new Inbox<SwiftnestEvent>();
  const close = vi.spyOn(stream, 'close');
  let finish!: (value: typeof stream) => void;
  const follow = vi.fn(() => new Promise<typeof stream>((resolve) => (finish = resolve)));
  const updates = observer();
  const stop = watchChatSession(clientWith(follow), 'chat', updates);
  stop();
  finish(stream);
  await vi.advanceTimersByTimeAsync(8000);
  expect(close).toHaveBeenCalledOnce();
  expect(updates.ready).not.toHaveBeenCalled();
  expect(updates.event).not.toHaveBeenCalled();
  expect(updates.failed).not.toHaveBeenCalled();
  expect(follow).toHaveBeenCalledOnce();
});
