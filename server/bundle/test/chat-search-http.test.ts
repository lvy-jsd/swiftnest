import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { ChatSearch } from '../src/chat-search/service.js';
import { searchHandler } from '../src/chat-search/http.js';
import { channelRoute } from '../../../packages/channel/src/routes.js';

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-search-http-'));
  const service = new ChatSearch(
    {
      sessions: { list: () => [] },
      sessionPersistence: {
        list: async () => [],
        open: async () => {
          throw new Error('Unexpected');
        },
      },
    },
    { home, localBaseUrl: 'http://127.0.0.1:9/v1', localModel: 'fake' },
  );
  const server = createServer(
    searchHandler(
      {
        admit: (request) =>
          request.headers.authorization
            ? { peer: { principal: { kind: request.headers.authorization } } }
            : { rejection: 401 },
      },
      service,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown) =>
    fetch(`${root}/swiftnest/api/search${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'owner', 'accept-language': 'zh-CN' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { root, request, close };
}

it('exposes owner-only search, status, validated settings and rebuild routes with localized errors', async () => {
  const { root, request, close } = await fixture();
  try {
    expect((await fetch(`${root}/swiftnest/api/search/status`)).status).toBe(401);
    expect((await fetch(`${root}/swiftnest/api/search/status`, { headers: { authorization: 'guest' } })).status).toBe(
      403,
    );
    expect(await (await request('/status')).json()).toMatchObject({
      indexedMessages: 0,
      semantic: false,
      embeddingSource: null,
    });
    expect(await (await request('?query=杭州')).json()).toEqual([]);
    for (const path of [
      '?query=x&limit=0',
      '?query=x&limit=1.5',
      '?query=x&limit=NaN',
      `?query=${'x'.repeat(1025)}`,
      '/unknown',
    ]) {
      expect((await request(path)).status).toBe(400);
    }
    const invalid = await request('/settings', { semantic: 'yes' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      text: { key: 'chatSearchInvalidSettings' },
      message: expect.stringContaining('设置'),
    });
    expect((await request('/settings', { enabled: false })).status).toBe(200);
    expect((await request('?query=x')).status).toBe(503);
    expect((await request('/settings', { enabled: true, embeddings: { source: 'remote' } })).status).toBe(400);
    expect((await request('/settings', { enabled: true, arbitrary: true })).status).toBe(400);
    expect((await request('/settings', { embeddings: { model: '../invalid model' } })).status).toBe(400);
    expect((await request('/settings', { enabled: true })).status).toBe(200);
    expect((await request('/rebuild', {})).status).toBe(200);
    expect((await request('/settings', { huge: 'x'.repeat(5000) })).status).toBe(400);
  } finally {
    await close();
  }
});

it('allows only the declared search routes through the App channel', () => {
  for (const path of ['/swiftnest/api/search', '/swiftnest/api/search/status'])
    expect(channelRoute('GET', path)).toBe(true);
  for (const path of ['/swiftnest/api/search/settings', '/swiftnest/api/search/rebuild'])
    expect(channelRoute('POST', path)).toBe(true);
  expect(channelRoute('GET', '/swiftnest/api/search/private')).toBe(false);
  expect(channelRoute('POST', '/swiftnest/api/search')).toBe(false);
});
