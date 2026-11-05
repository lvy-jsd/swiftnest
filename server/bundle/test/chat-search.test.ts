import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatIndex, type SearchEvent } from '../src/chat-search/store.js';
import { chunkText, fuseRanks, queryParts, snippet } from '../src/chat-search/text.js';
import { ChatSearch, type SearchSources } from '../src/chat-search/service.js';
import { SqliteVectors, cosine } from '../src/chat-search/vectors.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function home() {
  const directory = mkdtempSync(join(tmpdir(), 'swiftnest-search-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function index() {
  const store = new ChatIndex(home());
  cleanups.push(() => store.close());
  return store;
}
function user(seq: number, content: string, kind = 'user'): SearchEvent {
  return { seq, time: 1700000000000 + seq, type: 'user/message', data: { content, source: { kind } } };
}
function sources(events: SearchEvent[]): SearchSources {
  return {
    sessions: { list: () => [] },
    sessionPersistence: {
      list: async () => [{ header: { id: 'old' } }, { header: { id: 'child', origin: 'subagent' } }],
      open: vi.fn(async () => ({
        read: vi.fn(async (offset, length) => ({ events: events.slice(offset, offset + length) })),
        close: vi.fn(async () => {}),
      })),
    },
  };
}

it('chunks Unicode without splitting surrogate pairs and retains boundary phrases', () => {
  const chunks = chunkText('一🙂二三四五六', 4, 2);
  expect(chunks).toEqual(['一🙂二三', '二三四五', '四五六']);
  expect(chunkText('')).toEqual([]);
  expect(() => chunkText('x', 3, 3)).toThrow();
  const long = chunkText(`${'a'.repeat(1500)}跨边界词组${'b'.repeat(1700)}`);
  expect(long.some((chunk) => chunk.includes('跨边界词组'))).toBe(true);
});
it('splits on punctuation and keeps FTS syntax and LIKE wildcards literal', () => {
  expect(queryParts('杭州旅行 BICYCLE, 中 a? % _ \\')).toEqual({
    phrases: ['bicycle'],
    grams: ['杭州', '州旅', '旅行', '中', 'a'],
  });
  const store = index();
  store.consume({ id: 'one' }, [user(0, '杭州旅行 bicycle ab 100% a_b "quoted" NEAR(x) OR -test * 斜\\杠')]);
  for (const query of [
    '杭州旅行',
    '杭州',
    '中',
    'ab',
    '%',
    '_',
    '\\',
    '"quoted"',
    'NEAR(x)',
    'OR',
    '-test',
    '*',
    '"',
    '"""',
  ]) {
    expect(() => store.results(query, 20)).not.toThrow();
  }
  expect(store.results('杭州', 20)).toHaveLength(1);
  expect(store.results('%', 20)).toEqual([]);
  expect(store.results('100%', 20)).toHaveLength(1);
  expect(store.results('zq_qz', 20)).toEqual([]);
  expect(store.results('bicycle 杭', 20)).toHaveLength(1);
  expect(store.results('missing', 20)).toEqual([]);
});
it('finds CJK chats by overlapping bigrams and English chats by OR-ed phrases', () => {
  const store = index();
  store.consume({ id: 'cjk' }, [user(0, '我们周六去了那家叫川味小馆的餐厅')]);
  store.consume({ id: 'en' }, [user(0, 'a restaurant called Blue Door')]);
  const cjk = store.results('上周我们说的那个餐厅叫什么', 20);
  expect(cjk.map((row) => row.sessionId)).toContain('cjk');
  expect(cjk[0]!.highlights.map(([start, end]) => cjk[0]!.snippet.slice(start, end))).toContain('餐厅');
  expect(store.results('what restaurant called', 20).map((row) => row.sessionId)).toContain('en');
  expect(store.results('What restaurant was it called?', 20).map((row) => row.sessionId)).toContain('en');
});
it('ranks a doc containing every query word first among several docs', () => {
  const store = index();
  store.consume({ id: 'full' }, [user(0, 'the restaurant called Blue Door on Saturday')]);
  store.consume({ id: 'partial' }, [user(0, 'Blue Door')]);
  store.consume({ id: 'other' }, [user(0, 'a restaurant review')]);
  const results = store.results('restaurant called Blue Door', 20);
  expect(results[0]!.sessionId).toBe('full');
  expect(results).toHaveLength(3);
});
it('caps FTS phrases at 12 and grams at 24, and returns nothing for an empty query', () => {
  const cjk = Array.from({ length: 30 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
  const parts = queryParts(`${Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')} ${cjk}`);
  expect(parts.phrases).toHaveLength(12);
  expect(parts.grams).toHaveLength(24);
  expect(queryParts('   ')).toEqual({ phrases: [], grams: [] });
  const store = index();
  store.consume({ id: 'one' }, [user(0, '杭州旅行')]);
  expect(store.results('   ', 20)).toEqual([]);
});
it('uses BM25 ordering, title changes, text-only human/assistant messages, and message-level deduplication', () => {
  const store = index();
  store.consume({ id: 'verbose' }, [user(0, `bicycle ${'unrelated '.repeat(300)}`)]);
  store.consume({ id: 'concise' }, [
    user(0, 'bicycle bicycle bicycle'),
    { seq: 1, time: 10, type: 'session/title', data: { title: 'A trip' } },
    user(2, 'hidden bicycle runtime context', 'runtime'),
    {
      seq: 3,
      time: 20,
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'thinking', thinking: 'hidden reasoning' },
            { type: 'text', text: 'A lovely orchard' },
          ],
        },
      },
    },
    user(4, 'x'.repeat(2000) + ' bicycle '.repeat(300)),
  ]);
  const results = store.results('bicycle', 20);
  expect(results[0]!.sessionId).toBe('concise');
  expect(results.every((row) => !row.snippet.includes('runtime'))).toBe(true);
  expect(results).toHaveLength(3);
  expect(store.results('orchard', 20)[0]).toMatchObject({ title: 'A trip', role: 'assistant', time: 20 });
  expect(store.results('reasoning', 20)).toEqual([]);
  expect(store.count()).toBe(4);
});
it('fuses ranks with k=60, does not count duplicate ids twice, and keeps deterministic ties', () => {
  expect(fuseRanks([1, 2, 3], [4, 2, 1])).toEqual([1, 2, 4, 3]);
  expect(fuseRanks([1, 1, 2], [2])).toEqual([2, 1]);
  const value = snippet(`${'x'.repeat(300)}杭州旅行 <script> bicycle`, '杭州 旅行 bicycle');
  expect(value.snippet.startsWith('…')).toBe(true);
  expect(value.highlights.map(([start, end]) => value.snippet.slice(start, end))).toEqual(['杭州旅行', 'bicycle']);
});
it('persists checkpoints, reads only missing events, handles duplicates, pruning, deletion and rebuild', async () => {
  const directory = home();
  const events = [user(0, '杭州旅行 bicycle'), user(1, 'orchard')];
  const source = sources(events);
  let service = new ChatSearch(source, { home: directory, localBaseUrl: 'http://127.0.0.1:9/v1', localModel: 'fake' });
  cleanups.push(() => service.close());
  await service.start();
  service.event({ id: 'old', header: { id: 'old' } }, events[1]!);
  expect(await service.search('orchard')).toHaveLength(1);
  expect(service.status().indexedMessages).toBe(2);
  const open = vi.mocked(source.sessionPersistence.open);
  expect(open.mock.calls.map(([id]) => id)).toEqual(['old']);
  await service.close();
  events.push(user(2, 'later message'));
  service = new ChatSearch(source, { home: directory, localBaseUrl: 'http://127.0.0.1:9/v1', localModel: 'fake' });
  await service.start();
  const handle = await open.mock.results.at(-1)!.value;
  expect(handle.read).toHaveBeenNthCalledWith(1, 2, 256);
  expect(service.status().indexedMessages).toBe(3);
  await service.rebuild();
  expect(service.status().indexedMessages).toBe(3);
  service.dispose({ id: 'old', header: { id: 'old' } });
  expect(await service.search('bicycle')).toEqual([]);
  await service.rebuild();
  expect(service.status().indexedMessages).toBe(0);
  expect(statSync(join(directory, 'search/chats.db')).mode & 0o777).toBe(0o600);
});
it('does not checkpoint gaps or index subagents and removes orphan vectors on deletion', () => {
  const store = index();
  store.consume({ id: 'one' }, [user(2, 'gap')]);
  expect(store.through('one')).toBe(-1);
  store.consume({ id: 'one' }, [user(0, 'first'), user(1, 'second')]);
  store.consume({ id: 'child', origin: 'subagent' }, [user(0, 'secret')]);
  expect(store.count()).toBe(2);
  const vectors = new SqliteVectors(store.db);
  const id = vectors.pending('model')[0]!.id;
  vectors.put(id, 'model', [1, 0]);
  expect(vectors.search('model', [1, 0])).toEqual([id]);
  expect(vectors.search('other', [1, 0])).toEqual([]);
  store.deleteSession('one');
  expect(vectors.search('model', [1, 0])).toEqual([]);
  vectors.put(id, 'model', [1, 0]);
  expect(vectors.search('model', [1, 0])).toEqual([]);
  expect(cosine([0, 0], [1, 0])).toBe(0);
  expect(cosine([1, 2], [1])).toBe(0);
});

it('does not resurrect a session deleted during a catch-up read, and continues past unreadable sessions', async () => {
  const directory = home();
  let release!: (value: { events: SearchEvent[] }) => void;
  const read = new Promise<{ events: SearchEvent[] }>((resolve) => {
    release = resolve;
  });
  const source = sources([]);
  source.sessionPersistence.list = async () => [{ header: { id: 'broken' } }, { header: { id: 'old' } }];
  source.sessionPersistence.open = vi.fn(async (id) => {
    if (id === 'broken') throw new Error('Cannot read this session');
    return { read: async () => read, close: async () => {} };
  });
  const service = new ChatSearch(source, {
    home: directory,
    localBaseUrl: 'http://127.0.0.1:9/v1',
    localModel: 'fake',
  });
  cleanups.push(() => service.close());
  const starting = service.start();
  await expect.poll(() => vi.mocked(source.sessionPersistence.open).mock.calls.length).toBe(2);
  service.dispose({ id: 'old', header: { id: 'old' } });
  release({ events: [user(0, 'deleted text')] });
  await starting;
  expect(await service.search('deleted')).toEqual([]);
  expect(service.status().indexingFailed).toBe(true);
  expect(service.status().indexedMessages).toBe(0);
  source.sessionPersistence.list = async () => [];
  await service.rebuild();
  expect(service.status().indexingFailed).toBe(false);
});
it('preserves App choices across restarts and applies a changed server configuration', async () => {
  const directory = home();
  const source = sources([user(0, 'retained conversation')]);
  const config = {
    home: directory,
    localBaseUrl: 'http://127.0.0.1:9/v1',
    localModel: 'fake',
    settings: { semantic: false },
  };
  let service = new ChatSearch(source, config);
  cleanups.push(() => service.close());
  await service.start();
  await service.configure({ enabled: false, semantic: false });
  await service.close();
  service = new ChatSearch(source, config);
  expect(service.status().settings.enabled).toBe(false);
  await service.close();
  service = new ChatSearch(source, { ...config, settings: { enabled: true, semantic: true } });
  expect(service.status().settings.enabled).toBe(true);
  expect(service.status().settings.semantic).toBe(true);
  source.sessionPersistence.list = async () => [];
  await service.start();
  expect(service.status().indexedMessages).toBe(0);
});

it('recovers a live event whose seeded prefix has not reached persistence yet, without another event', async () => {
  const persisted: SearchEvent[] = [];
  const source = sources(persisted);
  const service = new ChatSearch(source, {
    home: home(),
    localBaseUrl: 'http://127.0.0.1:9/v1',
    localModel: 'fake',
    settings: { semantic: false },
  });
  cleanups.push(() => service.close());
  await service.start();
  service.event({ id: 'old', header: { id: 'old' } }, user(1, 'latest bicycle route'));
  expect(await service.search('bicycle')).toEqual([]);
  expect(service.index.through('old')).toBe(-1);
  persisted.push(user(0, 'seeded orchard notes'), user(1, 'latest bicycle route'));
  await expect.poll(async () => (await service.search('bicycle')).length).toBe(1);
  expect(service.index.through('old')).toBe(1);
  expect(service.status().indexedMessages).toBe(2);
  expect(service.status().indexingFailed).toBe(false);
});

it('retries a failed gap read without waiting for another live event', async () => {
  const events = [user(0, 'seed'), user(1, 'private bicycle')];
  const source = sources(events);
  const open = source.sessionPersistence.open;
  const list = source.sessionPersistence.list;
  source.sessionPersistence.list = vi.fn().mockRejectedValueOnce(new Error('Still listing')).mockImplementation(list);
  source.sessionPersistence.open = vi
    .fn()
    .mockRejectedValueOnce(new Error('Still publishing'))
    .mockImplementation(open);
  const service = new ChatSearch(source, {
    home: home(),
    localBaseUrl: 'http://127.0.0.1:9/v1',
    localModel: 'fake',
    settings: { semantic: false },
  });
  cleanups.push(() => service.close());
  service.event({ id: 'old', header: { id: 'old' } }, events[1]!);
  await expect.poll(async () => (await service.search('bicycle')).length, { timeout: 3000 }).toBe(1);
  expect(service.status().indexingFailed).toBe(false);
});

it('does not resurrect a deleted session from a delayed gap retry', async () => {
  const persisted: SearchEvent[] = [];
  const source = sources(persisted);
  const service = new ChatSearch(source, {
    home: home(),
    localBaseUrl: 'http://127.0.0.1:9/v1',
    localModel: 'fake',
    settings: { semantic: false },
  });
  cleanups.push(() => service.close());
  service.event({ id: 'old', header: { id: 'old' } }, user(1, 'deleted bicycle'));
  expect(await service.search('bicycle')).toEqual([]);
  service.dispose({ id: 'old', header: { id: 'old' } });
  persisted.push(user(0, 'seed'), user(1, 'deleted bicycle'));
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(await service.search('bicycle')).toEqual([]);
  expect(service.status().indexedMessages).toBe(0);
  expect(vi.mocked(source.sessionPersistence.open)).toHaveBeenCalledTimes(1);
});

it('does not return results when search is disabled during an in-flight semantic request', async () => {
  const service = new ChatSearch(sources([user(0, 'private bicycle')]), {
    home: home(),
    localBaseUrl: 'http://127.0.0.1:9/v1',
    localModel: 'fake',
  });
  cleanups.push(() => service.close());
  await service.start();
  let release!: (ids: number[]) => void;
  const semantic = vi.spyOn(service.embeddings, 'search').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const result = service.search('bicycle');
  const rejected = expect(result).rejects.toMatchObject({ text: { key: 'chatSearchDisabled' } });
  await expect.poll(() => semantic.mock.calls.length).toBe(1);
  await service.configure({ enabled: false });
  release([]);
  await rejected;
});
