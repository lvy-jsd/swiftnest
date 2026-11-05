import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { message } from '@swiftnest/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MemoryOperation } from '../src/memory/auto-schema.js';
import { memoryRules } from '../src/memory/rules.js';
import { MemoryStore } from '../src/memory/store.js';

let home: string;
let store: MemoryStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memory-auto-validation-'));
  store = new MemoryStore(home);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it.each<MemoryOperation>([
  { op: 'add', text: 'my api key: sk-abc...' },
  { op: 'add', text: 'x'.repeat(memoryRules.entry + 1) },
  { op: 'add', text: '' },
  { op: 'add', text: 'two\nlines' },
  { op: 'add', text: 'A fact', topic: '../escape' },
  { op: 'add', text: 'First fact', topic: '../escape' },
  { op: 'update', id: 'missing', text: 'A fact' },
])('skips a rejected operation and commits valid neighbors: %j', async (rejected) => {
  await store.applyAuto(
    'chat',
    7,
    [{ op: 'add', text: 'First fact' }, rejected, { op: 'add', text: 'Last fact' }],
    [],
    () => true,
  );
  expect((await store.list()).entries.map((entry) => entry.text)).toEqual(['First fact', 'Last fact']);
  expect(new MemoryStore(home).reviewed('chat')).toBe(7);
  expect(console.warn).toHaveBeenCalledOnce();
  expect(console.warn).toHaveBeenCalledWith(message('memoryAutoSkippedLog', undefined, [1]));
});

it('advances even when every operation is rejected and logs only the count', async () => {
  const secret = 'my api key: sk-abc...';
  await store.applyAuto(
    'chat',
    9,
    [
      { op: 'add', text: secret },
      { op: 'update', id: 'missing', text: 'Unknown fact' },
    ],
    [],
    () => true,
  );
  expect((await store.list()).entries).toEqual([]);
  expect(new MemoryStore(home).reviewed('chat')).toBe(9);
  expect(console.warn).toHaveBeenCalledOnce();
  expect(console.warn).toHaveBeenCalledWith(message('memoryAutoSkippedLog', undefined, [2]));
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret);
  expect(readFileSync(join(home, 'memory/MEMORY.md'), 'utf8')).not.toContain(secret);
});

it('skips an entry that would overflow the index but still fits a smaller fact', async () => {
  for (let index = 0; index < 9; index++) await store.remember(`${index}${'a'.repeat(299)}`);
  await store.remember('b'.repeat(100));
  const oversized = 'x'.repeat(memoryRules.entry);
  await store.applyAuto(
    'chat',
    4,
    [
      { op: 'add', text: oversized },
      { op: 'add', text: 'Small fact' },
    ],
    (await store.list()).entries,
    () => true,
  );
  const entries = (await store.list()).entries;
  expect(entries.some((entry) => entry.text === oversized)).toBe(false);
  expect(entries.at(-1)?.text).toBe('Small fact');
  expect(store.reviewed('chat')).toBe(4);
  expect(console.warn).toHaveBeenCalledWith(message('memoryAutoSkippedLog', undefined, [1]));
});

it('rolls back a move into a full topic without removing the original entry or frozen snapshot', async () => {
  const { entry } = await store.remember('Original fact');
  await store.writeTopic('Full', `# ${'a'.repeat(memoryRules.topic - 20)}`);
  store.snapshot('frozen');
  await store.applyAuto(
    'chat',
    4,
    [
      { op: 'update', id: entry.id, text: 'Replacement', topic: 'Full' },
      { op: 'add', text: 'Good fact' },
    ],
    (await store.list()).entries,
    () => true,
  );
  expect((await store.list()).entries).toMatchObject([entry, { text: 'Good fact', source: 'auto' }]);
  expect(store.snapshot('frozen')).toContain('Original fact');
  expect((await store.readTopic('Full')).content).not.toContain('Replacement');
  expect(store.reviewed('chat')).toBe(4);
  expect(console.warn).toHaveBeenCalledWith(message('memoryAutoSkippedLog', undefined, [1]));
});

it('skips creating too many topics and continues writing to an existing topic', async () => {
  for (let index = 0; index < memoryRules.topics; index++) await store.writeTopic(`Topic ${index}`, '');
  await store.applyAuto(
    'chat',
    4,
    [
      { op: 'add', text: 'Overflow', topic: 'Extra' },
      { op: 'add', text: 'Good fact', topic: 'Topic 0' },
    ],
    [],
    () => true,
  );
  expect((await store.list()).topics).toHaveLength(memoryRules.topics);
  expect((await store.list()).entries).toMatchObject([{ text: 'Good fact', topic: 'Topic 0' }]);
  expect(store.reviewed('chat')).toBe(4);
  expect(console.warn).toHaveBeenCalledWith(message('memoryAutoSkippedLog', undefined, [1]));
});

it('applies successive valid updates to an id from the original baseline', async () => {
  const { entry } = await store.remember('Original fact');
  await store.applyAuto(
    'chat',
    4,
    [
      { op: 'update', id: entry.id, text: 'First update' },
      { op: 'update', id: entry.id, text: 'Latest update' },
    ],
    [entry],
    () => true,
  );
  expect((await store.list()).entries).toMatchObject([{ id: entry.id, text: 'Latest update' }]);
  expect(console.warn).not.toHaveBeenCalled();
});

it('aborts the whole batch on a concurrent baseline change, without advancing the cursor', async () => {
  const { entry } = await store.remember('Original fact');
  const baseline = (await store.list()).entries;
  await store.edit(entry.id, 'Owner changed this');
  await expect(
    store.applyAuto(
      'chat',
      4,
      [
        { op: 'add', text: 'Good fact' },
        { op: 'add', text: 'password=hidden' },
      ],
      baseline,
      () => true,
    ),
  ).rejects.toThrow();
  expect((await store.list()).entries).toMatchObject([{ id: entry.id, text: 'Owner changed this' }]);
  expect(store.reviewed('chat')).toBe(0);
  expect(console.warn).not.toHaveBeenCalled();
});
