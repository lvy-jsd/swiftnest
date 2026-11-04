import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AutomaticMemory,
  AUTO_DELAY_MS,
  registerAutomaticMemory,
  type AutoContext,
  type MemoryEvent,
  type MemorySession,
} from '../src/memory/auto.js';
import { memoryOperations } from '../src/memory/auto-schema.js';
import { MemoryStore } from '../src/memory/store.js';

let home: string;
let store: MemoryStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memory-auto-'));
  store = new MemoryStore(home);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it.each([
  [{ op: 'add', text: 'Likes tea', topic: 'Preferences' }],
  [{ op: 'update', id: 'known', text: 'Likes coffee' }],
  [{ op: 'none' }],
])('accepts strict operations: %j', (operation) => {
  expect(memoryOperations.parse([operation])).toEqual([operation]);
});
it.each([
  '```json\n[]\n```',
  'null',
  '{}',
  '[]',
  '[{"op":"add","text":"ok","extra":true}]',
  '[{"op":"update","text":"missing id"}]',
  '[{"op":"none","text":"extra"}]',
  '[{"op":"add","text":"ok","topic":"../escape"}]',
  '[{"op":"add","text":""}]',
])('rejects invalid or extra data: %s', (output) => {
  expect(() => memoryOperations.parse(JSON.parse(output))).toThrow();
});

it('adds, deduplicates, replaces an id, and redacts old snapshots through the normal transaction', async () => {
  await store.applyAuto('one', 5, [{ op: 'add', text: 'Likes tea' }], [], () => true);
  const baseline = (await store.list()).entries;
  store.snapshot('frozen');
  await store.applyAuto('two', 8, [{ op: 'add', text: 'likes tea', topic: 'Other' }], baseline, () => true);
  expect((await store.list()).entries).toHaveLength(1);
  await store.applyAuto(
    'two',
    10,
    [{ op: 'update', id: baseline[0]!.id, text: 'Likes coffee', topic: 'Preferences' }],
    baseline,
    () => true,
  );
  expect((await store.list()).entries).toMatchObject([
    { id: baseline[0]!.id, text: 'Likes coffee', source: 'auto', topic: 'Preferences' },
  ]);
  expect(store.snapshot('frozen')).not.toContain('Likes tea');
  expect(await store.recentAuto()).toMatchObject([{ text: 'Likes coffee', added: expect.any(String) }]);
  expect(new MemoryStore(home).reviewed('two')).toBe(10);
  expect(readFileSync(join(home, 'memory/journal.jsonl'), 'utf8')).not.toContain('Likes tea');
});

it('rejects a whole batch containing a secret, unknown id, stale update or over-limit fact without advancing', async () => {
  const { entry } = await store.remember('Original fact');
  const baseline = (await store.list()).entries;
  for (const operation of [
    { op: 'add' as const, text: 'password=hidden' },
    { op: 'update' as const, id: 'missing', text: 'New fact' },
  ]) {
    await expect(
      store.applyAuto('one', 4, [{ op: 'add', text: 'Valid fact' }, operation], baseline, () => true),
    ).rejects.toThrow();
    expect((await store.list()).entries).toEqual(baseline);
    expect(store.reviewed('one')).toBe(0);
  }
  await store.edit(entry.id, 'Owner changed this');
  await expect(
    store.applyAuto('one', 4, [{ op: 'update', id: entry.id, text: 'Stale fact' }], baseline, () => true),
  ).rejects.toThrow();
  await expect(
    store.applyAuto('one', 4, [{ op: 'add', text: 'x'.repeat(301) }], baseline, () => true),
  ).rejects.toThrow();
});

it('replays facts and cursor together after an interrupted pending transaction', async () => {
  const interrupted = new MemoryStore(home, (step) => {
    if (step === 'MEMORY.md') throw new Error('crash');
  });
  await expect(
    interrupted.applyAuto('session', 9, [{ op: 'add', text: 'Durable fact' }], [], () => true),
  ).rejects.toThrow('crash');
  const restarted = new MemoryStore(home);
  expect(restarted.reviewed('session')).toBe(9);
  expect((await restarted.list()).entries).toMatchObject([{ text: 'Durable fact', source: 'auto' }]);
});

function harness(output = '[{"op":"add","text":"Likes tea"}]', id = 'chat', shared?: AutomaticMemory) {
  const events: MemoryEvent[] = [];
  const session: MemorySession = { id, header: {}, snapshotEvents: () => [...events] };
  const requests: Parameters<AutoContext['llm']['stream']>[0][] = [];
  const stream = vi.fn(async function* (options) {
    requests.push(options);
    yield { type: 'text-delta', text: output };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const ctx = { llm: { stream }, sessions: { list: () => [session], flush: vi.fn(async () => {}) } };
  const automatic = shared ?? new AutomaticMemory(ctx, store, true, 100);
  vi.setSystemTime(Date.now() + 1);
  const append = (type: string, data: MemoryEvent['data'] = {}) => {
    const event = { seq: events.length, time: Date.now(), type, data };
    events.push(event);
    automatic.observe(session, event);
  };
  const start = (text = 'I like tea') => {
    append('turn/start');
    append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
    append('request/context', { provider: 'chat-provider', model: 'chat-model' });
  };
  return { ctx, automatic, append, start, requests, session, events, stream };
}

it('waits for quiet, resets on a new turn, uses only new owner messages and the chat route', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.start();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.stream).not.toHaveBeenCalled();
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(99);
  h.start('I prefer coffee now');
  await vi.advanceTimersByTimeAsync(500);
  expect(h.stream).not.toHaveBeenCalled();
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledOnce();
  expect(h.requests[0]).toMatchObject({ provider: 'chat-provider', model: 'chat-model' });
  expect(h.requests[0]!.messages[0]!.content).toEqual([
    { type: 'text', text: expect.stringContaining('I prefer coffee now') },
  ]);
  const restarted = new AutomaticMemory(h.ctx, new MemoryStore(home), true, 100);
  restarted.observe(h.session);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledOnce();
  h.start('Only this is new');
  h.append('user/message', { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'injected' }] });
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  const input = JSON.stringify(h.requests.at(-1)!.messages);
  expect(input).toContain('Only this is new');
  expect(input).not.toContain('I prefer coffee now');
  expect(input).not.toContain('injected');
  h.automatic.dispose();
  restarted.dispose();
});

it('aborts a review when a new turn starts and never overlaps reviews or commits stale output', async () => {
  vi.useFakeTimers();
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.stream.mockImplementationOnce(async function* (options) {
    h.requests.push(options);
    await gate;
    yield { type: 'text-delta', text: '[{"op":"add","text":"Stale fact"}]' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  h.start();
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  h.start('New turn');
  expect(h.requests[0]!.signal?.aborted).toBe(true);
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(500);
  expect(h.stream).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledTimes(2);
  expect((await store.list()).entries.some((entry) => entry.text === 'Stale fact')).toBe(false);
  h.automatic.dispose();
});

it('logs invalid JSON without its content, retries once later, then waits for another turn', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = harness('invalid password=hidden');
  h.start();
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  expect(store.reviewed('chat')).toBe(0);
  expect((await store.list()).entries).toEqual([]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.stream).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.stream).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warning.mock.calls)).not.toContain('hidden');
  h.automatic.dispose();
});

it('persists off across restart, cancels work, and skips subagents', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.start();
  h.append('turn/end');
  await store.setAuto(false);
  h.automatic.settingsChanged();
  await vi.advanceTimersByTimeAsync(1000);
  expect(new MemoryStore(home).autoSettings()).toEqual({ enabled: false });
  expect(h.stream).not.toHaveBeenCalled();
  await store.setAuto(true);
  h.automatic.settingsChanged();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).not.toHaveBeenCalled();
  h.start('A new preference after enabling');
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledOnce();
  h.automatic.observe({ ...h.session, id: 'child', header: { origin: 'subagent' } });
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledOnce();
  h.automatic.dispose();
});

it('recovers an unopened quiet persisted session after restart without taking write ownership', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.start();
  h.append('turn/end');
  h.automatic.dispose();
  const close = vi.fn(async () => {});
  const disposals: (() => void)[] = [];
  const ctx: AutoContext = {
    ...h.ctx,
    sessions: {
      list: () => [],
      flush: vi.fn(async () => {
        throw new Error('offline session');
      }),
    },
    sessionPersistence: {
      list: async () => [{ header: { id: 'chat' } }],
      open: vi.fn(async () => ({ read: async () => ({ events: h.events }), close })),
    },
    on: () => () => {},
    effect: (effect) => {
      disposals.push(effect());
    },
  };
  registerAutomaticMemory(ctx, store, true, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(ctx.sessionPersistence.open).toHaveBeenCalledWith('chat', 'read');
  expect(close).toHaveBeenCalledOnce();
  expect((await store.list()).entries).toHaveLength(1);
  expect(ctx.sessions.flush).not.toHaveBeenCalled();
  for (const dispose of disposals) dispose();
});

it('does not overlap a disposed chat review with a resumed copy of the same session', async () => {
  vi.useFakeTimers();
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.stream.mockImplementationOnce(async function* () {
    await gate;
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  h.start();
  h.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  h.automatic.remove('chat');
  h.automatic.observe({ ...h.session });
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledTimes(2);
  expect((await store.list()).entries).toHaveLength(1);
  h.automatic.dispose();
});

it('commits none as a durable cursor and rejects a proposal if the chat becomes active in the write queue', async () => {
  expect(await store.applyAuto('none', 12, [{ op: 'none' }], [], () => true)).toBe(true);
  expect(new MemoryStore(home).reviewed('none')).toBe(12);
  expect(await store.applyAuto('active', 4, [{ op: 'add', text: 'Stale fact' }], [], () => false)).toBe(false);
  expect(store.reviewed('active')).toBe(0);
  expect((await store.list()).entries).toEqual([]);
});

it('returns recent current facts newest first, including the date of an automatic replacement', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  await store.applyAuto('one', 1, [{ op: 'add', text: 'First fact' }], [], () => true);
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  const baseline = (await store.list()).entries;
  await store.applyAuto('two', 1, [{ op: 'add', text: 'Second fact' }], baseline, () => true);
  expect((await store.recentAuto()).map((entry) => entry.text)).toEqual(['Second fact', 'First fact']);
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  await store.applyAuto(
    'one',
    2,
    [{ op: 'update', id: baseline[0]!.id, text: 'First updated' }],
    (await store.list()).entries,
    () => true,
  );
  expect((await store.recentAuto()).map((entry) => [entry.text, entry.added])).toEqual([
    ['First updated', '2026-11-03T00:00:00.000Z'],
    ['Second fact', '2026-11-02T00:00:00.000Z'],
  ]);
  expect(memoryOperations.parse([{ op: 'add', text: '🙂'.repeat(300) }])).toHaveLength(1);
});

it('rejects stale additions when another review changed the supplied memory baseline', async () => {
  const baseline = (await store.list()).entries;
  await store.remember('A newer owner instruction');
  await expect(
    store.applyAuto('race', 5, [{ op: 'add', text: 'An outdated proposal' }], baseline, () => true),
  ).rejects.toThrow();
  expect((await store.list()).entries).toMatchObject([{ text: 'A newer owner instruction' }]);
  expect(store.reviewed('race')).toBe(0);
});

it('serializes reviews globally and gives queued sessions the latest committed facts', async () => {
  vi.useFakeTimers();
  const first = harness();
  const second = harness(undefined, 'second', first.automatic);
  const third = harness(undefined, 'third', first.automatic);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.stream.mockImplementationOnce(async function* (options) {
    first.requests.push(options);
    await gate;
    yield { type: 'text-delta', text: '[{"op":"add","text":"First fact"}]' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  for (const chat of [first, second, third]) {
    chat.start(chat.session.id);
    chat.append('turn/end');
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(first.stream).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.stream).toHaveBeenCalledTimes(3);
  const inputs = first.requests.map((request) => JSON.parse(request.messages[0]!.content[0]!.text!));
  expect(inputs.map((input) => input.messages[0].text)).toEqual(['chat', 'second', 'third']);
  expect(inputs[1].entries).toMatchObject([{ text: 'First fact' }]);
  expect(inputs[2].entries).toHaveLength(2);
  first.automatic.dispose();
});

it('removes a queued session on a new turn and waits for its new quiet period', async () => {
  vi.useFakeTimers();
  const first = harness();
  const queued = harness(undefined, 'queued', first.automatic);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.stream.mockImplementationOnce(async function* () {
    await gate;
    yield { type: 'text-delta', text: '[{"op":"none"}]' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  first.start();
  first.append('turn/end');
  queued.start('Original queued turn');
  queued.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  queued.start('New queued turn');
  release();
  await vi.advanceTimersByTimeAsync(500);
  expect(first.stream).toHaveBeenCalledOnce();
  queued.append('turn/end');
  await vi.advanceTimersByTimeAsync(99);
  expect(first.stream).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(first.stream).toHaveBeenCalledTimes(2);
  first.automatic.dispose();
});

it('uses a two-minute production quiet period', async () => {
  vi.useFakeTimers();
  expect(AUTO_DELAY_MS).toBe(120_000);
  const h = harness();
  h.start();
  h.append('turn/end');
  h.automatic.dispose();
  const automatic = new AutomaticMemory(h.ctx, store);
  automatic.observe(h.session);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(h.stream).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.stream).toHaveBeenCalledOnce();
  automatic.dispose();
});

function persistedContext(ctx: Pick<AutoContext, 'llm' | 'sessions'>, sessions: MemorySession[]): AutoContext {
  return {
    ...ctx,
    sessions: { list: () => [], flush: vi.fn(async () => {}) },
    sessionPersistence: {
      list: async () => sessions.map((session) => ({ header: { ...session.header, id: session.id } })),
      open: async (id) => ({
        read: async () => ({ events: sessions.find((session) => session.id === id)!.snapshotEvents() }),
        close: async () => {},
      }),
    },
    on: () => () => {},
    effect: () => {},
  };
}

it('starts upgrades at the enable time, without reviewing hundreds of old persisted chats', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.start('An old owner preference');
  h.append('turn/end');
  h.automatic.dispose();
  writeFileSync(join(home, 'memory/auto.json'), JSON.stringify({ cursors: {} }));
  await vi.advanceTimersByTimeAsync(1000);
  const sessions = Array.from({ length: 200 }, (_, index) => ({ ...h.session, id: `old-${index}` }));
  const ctx = persistedContext(h.ctx, sessions);
  const first = registerAutomaticMemory(ctx, store, true, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).not.toHaveBeenCalled();
  const enabledAt = store.autoEnabledAt();
  expect(enabledAt).toBeGreaterThan(h.events.at(-1)!.time);
  first.dispose();
  const restarted = registerAutomaticMemory(ctx, new MemoryStore(home), true, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).not.toHaveBeenCalled();
  expect(store.autoEnabledAt()).toBe(enabledAt);
  h.start('A new owner preference');
  h.append('turn/end');
  restarted.observe(h.session);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.stream).toHaveBeenCalledOnce();
  const input = JSON.stringify(h.requests[0]!.messages);
  expect(input).toContain('A new owner preference');
  expect(input).not.toContain('An old owner preference');
  restarted.dispose();
});

it('excludes off-period messages after re-enabling and restarting, with and without a cursor', async () => {
  vi.useFakeTimers();
  const existing = harness('[{"op":"none"}]');
  existing.start('Already reviewed');
  existing.append('turn/end');
  await vi.advanceTimersByTimeAsync(100);
  expect(store.reviewed('chat')).toBe(4);
  await store.setAuto(false);
  existing.automatic.settingsChanged();
  const fresh = harness(undefined, 'fresh', existing.automatic);
  for (const chat of [existing, fresh]) {
    chat.start('An off-period preference');
    chat.append('turn/end');
  }
  await vi.advanceTimersByTimeAsync(100);
  await store.setAuto(true);
  const enabledAt = store.autoEnabledAt();
  existing.automatic.settingsChanged();
  await vi.advanceTimersByTimeAsync(100);
  expect(existing.stream).toHaveBeenCalledOnce();
  existing.automatic.dispose();
  const ctx = persistedContext(existing.ctx, [existing.session, fresh.session]);
  const restarted = registerAutomaticMemory(ctx, new MemoryStore(home), true, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(existing.stream).toHaveBeenCalledOnce();
  await store.setAuto(true);
  expect(store.autoEnabledAt()).toBe(enabledAt);
  for (const chat of [existing, fresh]) {
    chat.start(`New preference in ${chat.session.id}`);
    chat.append('turn/end');
    restarted.observe(chat.session);
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(existing.stream).toHaveBeenCalledTimes(3);
  for (const request of existing.requests.slice(1)) {
    const input = JSON.stringify(request.messages);
    expect(input).toContain('New preference');
    expect(input).not.toContain('off-period');
    expect(input).not.toContain('Already reviewed');
  }
  restarted.dispose();
});
