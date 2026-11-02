import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appHandler } from '../src/app.js';

describe('public App static route', () => {
  let dir: string;
  let root: string;
  const server = createServer((req, res) => appHandler(req.headers['x-no-dist'] ? undefined : root)(req, res));
  let port: number;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swiftnest-static-'));
    root = join(dir, 'dist');
    await mkdir(join(root, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'index.html'), '<html><head></head><body>Swiftnest</body></html>'),
      writeFile(join(root, 'assets', 'index-ABcd1234.js'), 'export {};'),
      writeFile(join(root, 'assets', 'index-ABcd1234.css'), 'body {}'),
      writeFile(join(root, 'logo.svg'), '<svg/>'),
      writeFile(join(dir, 'secret.txt'), 'outside'),
    ]);
    await symlink(join(dir, 'secret.txt'), join(root, 'leak.txt'));
    await symlink(dir, join(root, 'escape'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  function get(
    path: string,
    method = 'GET',
    headers = {},
  ): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.on('data', (data) => (body += data));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  it('serves an unauthenticated index, canonical slash and SPA deep links', async () => {
    expect(await get('/app')).toMatchObject({ status: 302, headers: { location: '/app/' } });
    for (const path of ['/app/', '/app/index.html', '/app/chats/real-chat?ignored=yes']) {
      expect(await get(path)).toMatchObject({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
        body: '<html><head><base href="/app/"></head><body>Swiftnest</body></html>',
      });
    }
  });
  it('uses correct MIME and immutable caching only for built hashed assets', async () => {
    expect(await get('/app/assets/index-ABcd1234.js')).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
    expect(await get('/app/assets/index-ABcd1234.css')).toMatchObject({
      status: 200,
      headers: { 'content-type': 'text/css; charset=utf-8' },
    });
    expect(await get('/app/logo.svg')).toMatchObject({
      status: 200,
      headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' },
    });
    expect((await get('/app/assets/missing.js')).status).toBe(404);
    expect((await get('/app/missing.png')).status).toBe(404);
  });
  it('rejects traversal, malformed escapes, absolute paths and escaping symlinks', async () => {
    for (const path of [
      '/app/../secret.txt',
      '/app/%2e%2e/secret.txt',
      '/app/%2e%2e%2fsecret.txt',
      '/app/%5c..%5csecret.txt',
      '/app/%00',
      '/app/%zz',
      '/app//etc/passwd',
      '/app/leak.txt',
      '/app/escape/secret.txt',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain('outside');
    }
  });
  it('reports a missing build clearly and rejects mutations', async () => {
    expect(await get('/app/', 'GET', { 'x-no-dist': '1' })).toMatchObject({
      status: 404,
      body: expect.stringContaining('SWIFTNEST_APP_DIST'),
    });
    expect((await get('/app/', 'POST')).status).toBe(405);
    await rm(join(root, 'index.html'));
    expect(await get('/app/')).toMatchObject({ status: 404, body: expect.stringContaining('SWIFTNEST_APP_DIST') });
  });
});
