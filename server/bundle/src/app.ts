import { render, text, type Text } from '@swiftnest/protocol';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.avif': 'image/avif',
};
function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

/** Public shell only. The App pairs separately against the existing authenticated API. */
export function appHandler(dist?: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, message: Text) => {
      const body = render(message);
      res
        .writeHead(status, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        .end(body);
    };
    if (req.method !== 'GET') {
      reply(405, text('appGet'));
      return;
    }
    if (!dist) {
      reply(404, text('appMissing'));
      return;
    }
    const raw = (req.url ?? '').split('?', 1)[0]!;
    if (raw === '/app') {
      res.writeHead(302, { location: '/app/', 'cache-control': 'no-store' }).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(raw.slice('/app/'.length));
    } catch {
      reply(400, text('appPath'));
      return;
    }
    if (
      !raw.startsWith('/app/') ||
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((p) => p === '..' || p === '.')
    ) {
      reply(400, text('appPath'));
      return;
    }
    try {
      const root = await realpath(dist);
      const index = resolve(root, 'index.html');
      if (!(await stat(index)).isFile()) throw new Error('Missing index');
      let file = resolve(root, path || 'index.html');
      if (!inside(root, file)) {
        reply(403, text('appPath'));
        return;
      }
      try {
        if (!(await stat(file)).isFile()) throw new Error('Not a file');
      } catch {
        // Missing assets must never receive HTML (or an immutable cache entry).
        if (path.startsWith('assets/') || extname(path)) {
          reply(404, text('appAsset'));
          return;
        }
        file = index;
      }
      file = await realpath(file);
      if (!inside(root, file)) {
        reply(403, text('appPath'));
        return;
      }
      let body = await readFile(file);
      if (file === index) {
        // Vite assets stay relative for Tauri. A server-only base also makes
        // index fallback work at nested /app/page/routes.
        body = Buffer.from(body.toString('utf8').replace(/<head(?:\s[^>]*)?>/i, '$&<base href="/app/">'));
      }
      const hashed = relative(root, file).startsWith(`assets${sep}`) && /[-.][A-Za-z0-9_-]{8,}\.[^.]+$/.test(file);
      res
        .writeHead(200, {
          'content-type': mime[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': body.length,
          'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
        .end(body);
    } catch {
      reply(404, text('appBuild'));
    }
  };
}
