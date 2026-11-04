import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { memoryHandler } from '../src/memory/http.js';
import { MemoryStore } from '../src/memory/store.js';

it('requires owner admission and routes all owner edits through validated, journaled memory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-memory-http-'));
  const events: string[] = [];
  const store = new MemoryStore(home, undefined, () => {
    events.push('memory-changed');
  });
  const server = createServer(
    memoryHandler(
      {
        admit: (req) =>
          req.headers.authorization === 'owner'
            ? { peer: { principal: { kind: 'owner' } } }
            : req.headers.authorization === 'guest'
              ? { peer: { principal: { kind: 'guest' } } }
              : { rejection: 401 },
      },
      store,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/swiftnest/api/memory`;
  const request = (path = '', body?: unknown, language = 'en') =>
    fetch(root + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'owner', 'accept-language': language },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    expect((await fetch(root)).status).toBe(401);
    expect((await fetch(root, { headers: { authorization: 'guest' } })).status).toBe(403);
    expect(await (await request('/auto')).json()).toEqual({ enabled: true });
    expect((await request('/auto', { enabled: 'false' })).status).toBe(400);
    expect((await request('/auto', { enabled: false, extra: true })).status).toBe(400);
    expect(await (await request('/auto', { enabled: false })).json()).toEqual({ enabled: false });
    expect(new MemoryStore(home).autoSettings()).toEqual({ enabled: false });
    const baseline = (await store.list()).entries;
    await store.applyAuto('chat', 4, [{ op: 'add', text: 'Auto fact' }], baseline, () => true);
    const recent = await (await request('/auto/recent')).json();
    expect(recent).toMatchObject([{ text: 'Auto fact', source: 'auto', added: expect.any(String) }]);
    await request('/delete', { id: recent[0].id });
    expect(await (await request('/auto/recent')).json()).toEqual([]);
    events.length = 0;
    const saved = await (await request('/add', { text: 'Owner fact' })).json();
    expect(saved.saved).toBe(true);
    expect(events).toEqual(['memory-changed']);
    expect((await (await request('/add', { text: 'Owner fact' })).json()).saved).toBe(false);
    expect(events).toHaveLength(1);
    expect((await (await request()).json()).entries).toHaveLength(1);
    expect((await request('/edit', { id: saved.entry.id, text: 'Edited fact' })).status).toBe(200);
    expect((await request('/topic', { topic: 'Details', content: '- Topic fact' })).status).toBe(200);
    expect(await (await request('/topic?topic=Details')).json()).toMatchObject({
      content: expect.stringContaining('Topic fact'),
    });
    const rejected = await request('/add', { text: 'password=hidden' }, 'zh-CN');
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      text: { key: 'memorySecret' },
      message: expect.stringContaining('密码'),
    });
    expect((await request('/delete', { id: saved.entry.id })).status).toBe(200);
    expect((await request('/delete', { id: saved.entry.id })).status).toBe(404);
    expect((await request('/topic?topic=..%2Fescape')).status).toBe(400);
    expect((await request('/add', { text: 'x'.repeat(140000) })).status).toBe(400);
    expect(events).toEqual(Array(4).fill('memory-changed'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
