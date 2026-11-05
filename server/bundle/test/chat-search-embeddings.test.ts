import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatIndex } from '../src/chat-search/store.js';
import { SqliteVectors } from '../src/chat-search/vectors.js';
import { Embeddings, isLocalEndpoint } from '../src/chat-search/embeddings.js';
import { searchSettings } from '../src/chat-search/settings.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-embeddings-'));
  const index = new ChatIndex(home);
  cleanups.push(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });
  for (let seq = 0; seq < 35; seq++)
    index.consume({ id: 'old' }, [
      {
        seq,
        time: seq,
        type: 'user/message',
        data: { source: { kind: 'user' }, content: `bicycle ${seq}` },
      },
    ]);
  return { home, index, vectors: new SqliteVectors(index.db) };
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}
it('keeps absent endpoints optional, batches in one lane, and re-embeds after a model change', async () => {
  const { home, index, vectors } = fixture();
  let supported = false;
  let active = 0;
  let maximum = 0;
  const requests: { model: string; input: string[] }[] = [];
  const url = await listen(
    createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.end('{"data":[{"id":"embed-v1"}]}');
        return;
      }
      if (!supported) {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const request = JSON.parse(body);
      requests.push(request);
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      res.end(
        JSON.stringify({ data: request.input.map((_input: string, index: number) => ({ index, embedding: [1, 0] })) }),
      );
    }),
  );
  let settings = searchSettings();
  const worker = new Embeddings({ home, localBaseUrl: url, localModel: 'chat-only' }, vectors, () => settings);
  cleanups.push(() => worker.close());
  worker.start(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(worker.active).toBeNull();
  expect(index.results('bicycle', 20)).toHaveLength(20);
  supported = true;
  worker.changed();
  await expect.poll(() => index.db.prepare('SELECT count(*) AS n FROM vectors').get()!.n).toBe(35);
  expect(requests.map((request) => request.input.length)).toEqual([1, 16, 16, 3]);
  expect(worker.active?.model).toBe('embed-v1');
  await Promise.all([worker.search('commute'), worker.search('cycling')]);
  expect(maximum).toBe(1);
  settings = searchSettings({ embeddings: { model: 'embed-v2' } });
  worker.changed();
  expect(index.db.prepare('SELECT count(*) AS n FROM vectors').get()!.n).toBe(0);
  await expect.poll(() => requests.filter((request) => request.model === 'embed-v2').length).toBe(4);
  await expect.poll(() => index.db.prepare('SELECT count(*) AS n FROM vectors').get()!.n).toBe(35);
  expect(worker.active?.model).toBe('embed-v2');
});
it.each([
  { key: false, consent: false },
  { key: true, consent: false },
  { key: false, consent: true },
])('never calls cloud without both key and consent: %j', async ({ key, consent }) => {
  const { home, vectors } = fixture();
  if (key) writeFileSync(join(home, 'model-keys.json'), JSON.stringify({ openai: 'sk-fake-test-key' }));
  const fetcher = vi.fn(() => {
    throw new Error('Forbidden outbound request');
  });
  vi.stubGlobal('fetch', fetcher);
  const settings = searchSettings({ embeddings: { source: 'cloud', cloudConsent: consent } });
  const worker = new Embeddings(
    { home, localBaseUrl: 'https://remote.example/v1', localModel: 'fake' },
    vectors,
    () => settings,
  );
  cleanups.push(() => worker.close());
  worker.start(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await worker.search('private search')).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses only the saved provider key with explicit cloud consent and stops after revocation', async () => {
  const { home, index, vectors } = fixture();
  writeFileSync(join(home, 'model-keys.json'), JSON.stringify({ openai: 'sk-fake-test-key' }));
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({ data: body.input.map((_input: string, index: number) => ({ index, embedding: [1, 0] })) });
  });
  vi.stubGlobal('fetch', fetcher);
  let settings = searchSettings({ embeddings: { source: 'cloud', cloudConsent: true } });
  const worker = new Embeddings(
    { home, localBaseUrl: 'http://127.0.0.1/v1', localModel: 'fake' },
    vectors,
    () => settings,
  );
  cleanups.push(() => worker.close());
  worker.start(0);
  await expect.poll(() => index.db.prepare('SELECT count(*) AS n FROM vectors').get()!.n).toBe(35);
  expect(fetcher.mock.calls[0]).toMatchObject([
    'https://api.openai.com/v1/embeddings',
    {
      headers: { authorization: 'Bearer sk-fake-test-key' },
      redirect: 'error',
    },
  ]);
  settings = searchSettings({ embeddings: { source: 'cloud', cloudConsent: false } });
  worker.changed();
  const before = fetcher.mock.calls.length;
  expect(await worker.search('private query')).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(fetcher.mock.calls.length).toBe(before);
});
it('does not trust a remote URL, embedded credentials, or a hostname that looks like a private address', () => {
  for (const url of [
    'https://example.com/v1',
    'http://10.attacker.com/v1',
    'http://127.0.0.1.attacker.com/v1',
    'http://user@localhost/v1',
    'file:///tmp/v1',
  ])
    expect(isLocalEndpoint(url)).toBe(false);
  for (const url of [
    'http://127.0.0.1:8000/v1',
    'http://10.0.0.2/v1',
    'http://192.168.1.1/v1',
    'http://172.20.0.1/v1',
    'http://[::1]/v1',
  ])
    expect(isLocalEndpoint(url)).toBe(true);
});

it('discovers and uses an embedding model on an authenticated local server', async () => {
  const { home, index, vectors } = fixture();
  const requests: { path: string; authorization?: string; model?: string }[] = [];
  const url = await listen(
    createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const model = body ? JSON.parse(body).model : undefined;
      requests.push({ path: req.url!, authorization: req.headers.authorization, model });
      if (req.headers.authorization !== 'Bearer local-test-key') {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/v1/models') {
        res.end('{"data":[{"id":"chat-only"},{"id":"local-embed"}]}');
        return;
      }
      const { input } = JSON.parse(body);
      res.end(JSON.stringify({ data: input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    }),
  );
  const worker = new Embeddings(
    { home, localBaseUrl: url, localModel: 'chat-only', localApiKey: 'local-test-key' },
    vectors,
    () => searchSettings(),
  );
  cleanups.push(() => worker.close());
  worker.start(0);
  await expect.poll(() => index.db.prepare('SELECT count(*) AS n FROM vectors').get()!.n).toBe(35);
  expect(worker.active?.model).toBe('local-embed');
  expect(requests[0]).toMatchObject({ path: '/v1/models', authorization: 'Bearer local-test-key' });
  expect(requests.slice(1).every((request) => request.model === 'local-embed')).toBe(true);
});

it('does not send local embeddings to a remote configured model server', async () => {
  const { home, vectors } = fixture();
  const fetcher = vi.fn(() => {
    throw new Error('Unexpected network');
  });
  vi.stubGlobal('fetch', fetcher);
  const worker = new Embeddings({ home, localBaseUrl: 'https://example.com/v1', localModel: 'fake' }, vectors, () =>
    searchSettings(),
  );
  cleanups.push(() => worker.close());
  worker.start(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects redirects without contacting their destination', async () => {
  const { home, vectors } = fixture();
  let contacted = 0;
  const destination = await listen(
    createServer((_req, res) => {
      contacted += 1;
      res.end('{}');
    }),
  );
  const url = await listen(
    createServer((req, res) => {
      if (req.url === '/v1/models') res.end('{"data":[{"id":"embed"}]}');
      else res.writeHead(302, { location: `${destination}/embeddings` }).end();
    }),
  );
  const worker = new Embeddings({ home, localBaseUrl: url, localModel: 'fake' }, vectors, () => searchSettings());
  cleanups.push(() => worker.close());
  worker.start(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(worker.active).toBeNull();
  expect(contacted).toBe(0);
});
it('discards a batch that finishes after permission has been revoked', async () => {
  const { home, index, vectors } = fixture();
  writeFileSync(join(home, 'model-keys.json'), JSON.stringify({ openai: 'sk-fake-test-key' }));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.input.length > 1) await pending;
    return Response.json({ data: body.input.map((_input: string, index: number) => ({ index, embedding: [1, 0] })) });
  });
  vi.stubGlobal('fetch', fetcher);
  let settings = searchSettings({ embeddings: { source: 'cloud', cloudConsent: true } });
  const worker = new Embeddings(
    { home, localBaseUrl: 'http://127.0.0.1/v1', localModel: 'fake' },
    vectors,
    () => settings,
  );
  cleanups.push(() => worker.close());
  worker.start(0);
  await expect.poll(() => fetcher.mock.calls.length).toBe(2);
  settings = searchSettings({ embeddings: { source: 'cloud', cloudConsent: false } });
  worker.changed();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(index.db.prepare('SELECT count(*) AS n FROM vectors').get()!.n).toBe(0);
  expect(await worker.search('private')).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([{ enabled: false }, { semantic: false }])(
  'does not discover or call local models when search is off: %j',
  async (value) => {
    const { home, vectors } = fixture();
    const fetcher = vi.fn(() => {
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetcher);
    const worker = new Embeddings({ home, localBaseUrl: 'http://127.0.0.1:9/v1', localModel: 'fake' }, vectors, () =>
      searchSettings(value),
    );
    cleanups.push(() => worker.close());
    worker.start(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await worker.search('private query')).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
