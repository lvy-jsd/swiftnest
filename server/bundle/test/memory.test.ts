import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import { parseMemory, serializeMemory } from '../src/memory/format.js';
import { memoryRules } from '../src/memory/rules.js';

const homes: string[] = [];
function home() {
  const value = mkdtempSync(join(tmpdir(), 'swiftnest-memory-'));
  homes.push(value);
  return value;
}
afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const read = (directory: string, file: string) => readFileSync(join(directory, 'memory', file), 'utf8');

describe('central memory', () => {
  it('preserves Markdown and metadata byte for byte', () => {
    const document = '# Memory\n\n- 用户偏好 {{model}} [source: owner; added: 2026-11-03]\n\n## Index\n- [[工作]]\n';
    const parsed = parseMemory(document);
    expect(serializeMemory(parsed)).toBe(document);
    expect(parsed.entries[0]).toMatchObject({ text: '用户偏好 {{model}}', source: 'owner' });
    expect(parsed.topics).toEqual(['工作']);
    expect(parseMemory(document).entries[0]?.id).toBe(parsed.entries[0]?.id);
  });
  it('supports list, duplicate, query, topic, edit and forget through one journal', async () => {
    const directory = home();
    const store = new MemoryStore(directory);
    expect(await store.recall()).toEqual({ entries: [], topics: [] });
    const saved = await store.remember('Prefers tea', 'Preferences');
    expect((await store.remember('Prefers tea', 'Preferences')).saved).toBe(false);
    expect((await store.list()).topics).toEqual([{ name: 'Preferences', entries: 1 }]);
    expect(await store.recall({ query: 'TEA' })).toMatchObject({ entries: [{ text: 'Prefers tea' }] });
    expect(await store.recall({ topic: 'Preferences' })).toMatchObject({
      content: expect.stringContaining('Prefers tea'),
    });
    await store.edit(saved.entry.id, 'Prefers coffee');
    expect((await store.list()).entries[0]?.id).toBe(saved.entry.id);
    await store.forget('Prefers coffee');
    await expect(store.forget('missing')).rejects.toMatchObject({ text: { key: 'memoryNotFound' } });
    const rows = read(directory, 'journal.jsonl')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows[1].changes[0]).toMatchObject({
      before: expect.stringContaining('Prefers tea'),
      after: expect.stringContaining('Prefers coffee'),
    });
  });
  it('checks Unicode entry, index, topic, and topic count limits without mutating on failure', async () => {
    const store = new MemoryStore(home());
    await expect(store.remember('茶'.repeat(memoryRules.entry + 1))).rejects.toMatchObject({
      text: { key: 'memoryEntryLimit' },
    });
    await store.remember('茶'.repeat(memoryRules.entry));
    for (let i = 0; i < 7; i++) await store.remember(`${i}${'a'.repeat(299)}`);
    const before = await store.list();
    await expect(
      Promise.all(Array.from({ length: 8 }, (_, i) => store.remember(`${i}${'b'.repeat(299)}`))),
    ).rejects.toMatchObject({ text: { key: 'memoryIndexLimit' } });
    expect((await store.list()).entries.length).toBeGreaterThanOrEqual(before.entries.length);
    await expect(store.writeTopic('Large', `# ${'a'.repeat(memoryRules.topic)}`)).rejects.toMatchObject({
      text: { key: 'memoryTopicLimit' },
    });
    const topics = new MemoryStore(home());
    for (let i = 0; i < memoryRules.topics; i++) await topics.writeTopic(`T${i}`, '');
    await expect(topics.remember('extra', 'Overflow')).rejects.toMatchObject({ text: { key: 'memoryTopicsLimit' } });
    await expect(store.remember('escape', '../outside')).rejects.toMatchObject({ text: { key: 'memoryInvalidTopic' } });
  });
  it.each([
    `sk-${'a'.repeat(24)}`,
    `ghp_${'x'.repeat(30)}`,
    'api_key=example',
    'password: hunter2',
    '-----BEGIN PRIVATE KEY-----',
    'Authorization: Bearer abcdefghijklmnop',
    '密码：测试密码',
    'https://user:password@example.com',
  ])('rejects secrets without writing them: %s', async (secret) => {
    const directory = home();
    const store = new MemoryStore(directory);
    await expect(store.remember(secret)).rejects.toMatchObject({ text: { key: 'memorySecret' } });
    await expect(store.writeTopic('Secrets', `# ${secret}`)).rejects.toMatchObject({ text: { key: 'memorySecret' } });
    expect(existsSync(join(directory, 'memory', 'pending.json'))).toBe(false);
    expect(existsSync(join(directory, 'memory', 'journal.jsonl'))).toBe(false);
  });
  it('normalizes owner topic writes, checks every entry and links the index', async () => {
    const store = new MemoryStore(home());
    const topic = await store.writeTopic('旅行', '# 旅行\n- Visit the coast\nVisit the mountains');
    expect(topic.content).toContain('[source: owner; added:');
    expect((await store.list()).entries).toHaveLength(2);
    expect((await store.list()).topics).toEqual([{ name: '旅行', entries: 2 }]);
    const ids = (await store.list()).entries.map((entry) => entry.id);
    await store.writeTopic('旅行', topic.content);
    expect((await store.list()).entries.map((entry) => entry.id)).toEqual(ids);
    await expect(store.writeTopic('旅行', 'a'.repeat(301))).rejects.toMatchObject({
      text: { key: 'memoryEntryLimit' },
    });
  });
  it('serializes concurrent writes and keeps frozen snapshots across saves and restarts', async () => {
    const directory = home();
    const store = new MemoryStore(directory);
    await store.remember('literal {{unknown}}');
    const frozen = store.snapshot('session-one');
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.remember(`Later fact ${i}`)));
    expect(store.snapshot('session-one')).toBe(frozen);
    expect(new MemoryStore(directory).snapshot('session-one')).toBe(frozen);
    expect(read(directory, 'snapshots/session-one.md')).toBe(frozen);
    expect(store.snapshot('session-two')).toContain('Later fact 4');
    expect(await store.recall({ query: 'Later fact' })).toMatchObject({ entries: expect.any(Array) });
    expect((await store.list()).entries).toHaveLength(6);
  });
});

it.each(['pending.json', 'MEMORY.md', 'topics/Work.md', 'journal.jsonl'])(
  'replays a crash after %s before the next read, exactly once',
  async (stop) => {
    const directory = home();
    let interrupted = false;
    const store = new MemoryStore(directory, (step) => {
      if (step === stop && !interrupted) {
        interrupted = true;
        throw new Error('simulated crash');
      }
    });
    await expect(store.remember('crash-safe entry', 'Work')).rejects.toThrow('simulated crash');
    const recovered = new MemoryStore(directory);
    expect((await recovered.list()).entries).toHaveLength(1);
    expect(read(directory, 'MEMORY.md')).toContain('[[Work]]');
    expect(read(directory, 'journal.jsonl').trim().split('\n')).toHaveLength(1);
    await recovered.list();
    expect(read(directory, 'journal.jsonl').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(directory, 'memory', 'pending.json'))).toBe(false);
  },
);

it('repairs a torn journal before replay and does not overwrite newer files for a committed pending id', async () => {
  const directory = home();
  let pending = '';
  const store = new MemoryStore(directory, (step) => {
    if (step === 'pending.json') pending = read(directory, 'pending.json');
  });
  await store.remember('first');
  await store.remember('second');
  writeFileSync(join(directory, 'memory', 'journal.jsonl'), `${read(directory, 'journal.jsonl')}{"id":"torn`);
  const recovered = new MemoryStore(directory);
  expect(read(directory, 'journal.torn')).toBe('{"id":"torn\n');
  await recovered.remember('third');
  writeFileSync(join(directory, 'memory', 'pending.json'), pending);
  expect((await recovered.list()).entries.map((entry) => entry.text)).toEqual(['first', 'second', 'third']);
  expect(read(directory, 'journal.jsonl').trim().split('\n')).toHaveLength(3);
});

it('denies storage symlinks and pending writes outside the owned file allowlist', async () => {
  const directory = home();
  const store = new MemoryStore(directory);
  symlinkSync(join(directory, 'outside'), join(directory, 'memory', 'MEMORY.md'));
  await expect(store.list()).rejects.toMatchObject({ text: { key: 'memoryInvalidData' } });
  rmSync(join(directory, 'memory', 'MEMORY.md'));
  writeFileSync(
    join(directory, 'memory', 'pending.json'),
    JSON.stringify({ id: 'bad', time: 'now', files: { '../outside': 'bad' }, changes: [] }),
  );
  await expect(store.list()).rejects.toMatchObject({ text: { key: 'memoryInvalidData' } });
  expect(existsSync(join(directory, 'outside'))).toBe(false);
});

it('repairs a partial journal append and replays pending before the next read in the same process', async () => {
  const directory = home();
  const store = new MemoryStore(directory, (step) => {
    if (step === 'topics/Work.md') throw new Error('partial append');
  });
  await expect(store.remember('recover after torn append', 'Work')).rejects.toThrow('partial append');
  const pending = JSON.parse(read(directory, 'pending.json'));
  const torn = `{"id":"${pending.id}","time":`;
  writeFileSync(join(directory, 'memory', 'journal.jsonl'), torn);
  const view = await store.list();
  expect(view.entries.map((entry) => entry.text)).toEqual(['recover after torn append']);
  expect(read(directory, 'journal.torn')).toBe(`${torn}\n`);
  expect(JSON.parse(read(directory, 'journal.jsonl')).id).toBe(pending.id);
  expect(existsSync(join(directory, 'memory', 'pending.json'))).toBe(false);
});
