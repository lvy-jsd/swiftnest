import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  readdirSync,
  utimesSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import { parseMemory, serializeMemory } from '../src/memory/format.js';
import { memoryRules } from '../src/memory/rules.js';
import { message } from '@swiftnest/protocol';

const homes: string[] = [];
function home() {
  const value = mkdtempSync(join(tmpdir(), 'swiftnest-memory-'));
  homes.push(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
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
    expect(Object.keys(rows[1]).sort()).toEqual(['id', 'time']);
    expect(memoryContents(directory)).not.toContain('Prefers tea');
    expect(memoryContents(directory)).not.toContain('Prefers coffee');
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

it.each(['pending.json', 'MEMORY.md', 'topics/Work.md', 'journal.jsonl', 'committed'])(
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
  expect(existsSync(join(directory, 'memory', 'journal.torn'))).toBe(false);
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
  expect(existsSync(join(directory, 'memory', 'journal.torn'))).toBe(false);
  expect(JSON.parse(read(directory, 'journal.jsonl')).id).toBe(pending.id);
  expect(existsSync(join(directory, 'memory', 'pending.json'))).toBe(false);
});

function memoryContents(directory: string): string {
  const root = join(directory, 'memory');
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile())
    .map((file) => readFileSync(join(file.parentPath, file.name), 'utf8'))
    .join('\n');
}

it.each(['forget', 'edit', 'topic'] as const)(
  'erases old text from the entire memory directory after %s',
  async (operation) => {
    const directory = home();
    const store = new MemoryStore(directory);
    const saved = await store.remember('旧事实 only once');
    await store.remember('Keep this line');
    const frozen = store.snapshot('existing');
    store.snapshot('another');
    await store.remember('Later save');
    // Upgrade an old journal, torn tail and abandoned temporary file containing original text.
    const journal = read(directory, 'journal.jsonl');
    const row = JSON.parse(journal.split('\n')[0]!);
    writeFileSync(
      join(directory, 'memory', 'journal.jsonl'),
      `${JSON.stringify({ ...row, changes: [{ before: saved.entry.line }] })}\n${journal}`,
    );
    writeFileSync(join(directory, 'memory', 'journal.torn'), saved.entry.line);
    writeFileSync(join(directory, 'memory', 'snapshots', 'abandoned.md.tmp'), saved.entry.line);
    if (operation === 'forget') await store.forget(saved.entry.id);
    else if (operation === 'edit') await store.edit(saved.entry.id, 'Replacement fact');
    else {
      const topic = await store.remember('Old topic fact', 'Work');
      await store.writeTopic('Work', '- New topic fact');
      expect(memoryContents(directory)).not.toContain(topic.entry.text);
      await store.forget(saved.entry.id);
    }
    expect(memoryContents(directory)).not.toContain(saved.entry.text);
    const redacted = frozen
      .split('\n')
      .filter((line) => line !== saved.entry.line)
      .join('\n');
    expect(store.snapshot('existing')).toBe(redacted);
    expect(store.snapshot('another')).toBe(redacted);
    expect(new MemoryStore(directory).snapshot('existing')).toBe(redacted);
    expect(redacted).not.toContain('Later save');
    expect(redacted).not.toContain('Replacement fact');
  },
);

it.each(['forget', 'edit'] as const)(
  'recovers %s at every transaction boundary with redacted snapshots exactly once',
  async (operation) => {
    for (const stop of [
      'pending.json',
      'MEMORY.md',
      'snapshots/one.md',
      'snapshots/two.md',
      'journal.jsonl',
      'committed',
    ]) {
      const directory = home();
      const initial = new MemoryStore(directory);
      const saved = await initial.remember('Never retain this old text');
      await initial.remember('Kept fact');
      const frozen = initial.snapshot('one');
      initial.snapshot('two');
      const store = new MemoryStore(directory, (step) => {
        if (step === stop) throw new Error('crash');
      });
      await expect(
        operation === 'forget' ? store.forget(saved.entry.id) : store.edit(saved.entry.id, 'New text'),
      ).rejects.toThrow('crash');
      const recovered = new MemoryStore(directory);
      const view = await recovered.list();
      expect(view.entries.map((entry) => entry.text)).toEqual(
        operation === 'forget' ? ['Kept fact'] : ['New text', 'Kept fact'],
      );
      expect(memoryContents(directory)).not.toContain(saved.entry.text);
      expect(recovered.snapshot('one')).toBe(frozen.replace(`${saved.entry.line}\n`, ''));
      await recovered.list();
      expect(read(directory, 'journal.jsonl').trim().split('\n')).toHaveLength(3);
      expect(existsSync(join(directory, 'memory', 'pending.json'))).toBe(false);
    }
  },
);

it('prunes only snapshots older than the policy at startup and removes a deleted session snapshot', () => {
  const directory = home();
  const store = new MemoryStore(directory);
  store.snapshot('old');
  const recent = store.snapshot('recent');
  const expired = new Date(Date.now() - (memoryRules.snapshotDays + 1) * 24 * 60 * 60 * 1000);
  utimesSync(join(directory, 'memory', 'snapshots', 'old.md'), expired, expired);
  const restarted = new MemoryStore(directory);
  expect(existsSync(join(directory, 'memory', 'snapshots', 'old.md'))).toBe(false);
  expect(restarted.snapshot('recent')).toBe(recent);
  restarted.deleteSnapshot('recent');
  restarted.deleteSnapshot('recent');
  expect(existsSync(join(directory, 'memory', 'snapshots', 'recent.md'))).toBe(false);
});

it.each(['sync', 'async'] as const)('committed changes succeed and log a failed %s notification', async (mode) => {
  const directory = home();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = () => {
    throw new Error('transport unavailable');
  };
  const store = new MemoryStore(directory, undefined, mode === 'sync' ? failure : async () => failure());
  const saved = await store.remember('Saved despite transport');
  expect(saved.saved).toBe(true);
  expect(read(directory, 'MEMORY.md')).toContain(saved.entry.text);
  await expect(store.edit(saved.entry.id, 'Edited despite transport')).resolves.toMatchObject({
    entries: [{ text: 'Edited despite transport' }],
  });
  expect(read(directory, 'MEMORY.md')).toContain('Edited despite transport');
  await expect(store.forget(saved.entry.id)).resolves.toEqual({ entries: [], topics: [] });
  expect(memoryContents(directory)).not.toContain('Edited despite transport');
  expect((await new MemoryStore(directory).list()).entries).toEqual([]);
  expect(warning).toHaveBeenCalledTimes(3);
  expect(warning).toHaveBeenCalledWith(message('memoryNotificationFailedLog'));
  expect(existsSync(join(directory, 'memory', 'pending.json'))).toBe(false);
});

function seedJournal(directory: string, count: number): string[] {
  const rows = Array.from({ length: count }, (_, index) => JSON.stringify({ id: `old-${index}`, time: '2026-11-03' }));
  writeFileSync(join(directory, 'memory', 'journal.jsonl'), `${rows.join('\n')}\n`);
  return rows;
}

it('keeps only recent commit markers on recovery and after each new commit', async () => {
  const directory = home();
  new MemoryStore(directory);
  const rows = seedJournal(directory, memoryRules.journalRows + 5);
  const store = new MemoryStore(directory);
  expect(read(directory, 'journal.jsonl').trim().split('\n')).toEqual(rows.slice(-memoryRules.journalRows));
  await store.remember('Bounded journal');
  const committed = read(directory, 'journal.jsonl').trim().split('\n');
  expect(committed).toHaveLength(memoryRules.journalRows);
  expect(committed.slice(0, -1)).toEqual(rows.slice(-(memoryRules.journalRows - 1)));
  expect(Object.keys(JSON.parse(committed.at(-1)!)).sort()).toEqual(['id', 'time']);
});

it('does not rewrite a clean bounded journal on reads, prompt renders or restart', async () => {
  const directory = home();
  const store = new MemoryStore(directory);
  await store.remember('Keep journal bytes');
  seedJournal(directory, memoryRules.journalRows);
  const journal = join(directory, 'memory', 'journal.jsonl');
  const past = new Date('2020-01-01');
  utimesSync(journal, past, past);
  const before = statSync(journal);
  const content = read(directory, 'journal.jsonl');
  await store.list();
  await store.recall();
  store.snapshot('one');
  new MemoryStore(directory).snapshot('one');
  const after = statSync(journal);
  expect(read(directory, 'journal.jsonl')).toBe(content);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ctimeMs).toBe(before.ctimeMs);
});

it.each(['journal.appended', 'journal.jsonl'])(
  'keeps replay deduplication across pruning with a crash at %s',
  async (stop) => {
    const directory = home();
    const store = new MemoryStore(directory, (step) => {
      if (step === stop) throw new Error('crash while pruning journal');
    });
    seedJournal(directory, memoryRules.journalRows);
    await expect(store.remember('Committed once')).rejects.toThrow('crash while pruning journal');
    const pending = JSON.parse(read(directory, 'pending.json'));
    const rows = read(directory, 'journal.jsonl').trim().split('\n').slice(-memoryRules.journalRows);
    expect(JSON.parse(rows.at(-1)!).id).toBe(pending.id);
    // A committed replay must skip file replacement as well as skip appending its marker.
    const document = join(directory, 'memory', 'MEMORY.md');
    const before = statSync(document);
    const recovered = new MemoryStore(directory);
    expect((await recovered.list()).entries.map((entry) => entry.text)).toEqual(['Committed once']);
    expect(statSync(document).ino).toBe(before.ino);
    expect(read(directory, 'journal.jsonl').trim().split('\n')).toEqual(rows);
    expect(existsSync(join(directory, 'memory', 'pending.json'))).toBe(false);
  },
);
