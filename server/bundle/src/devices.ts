import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Use the kernel's own signed-session and Host/Origin admission, including owner scope. */
export interface DeviceConnection {
  admit(request: { headers: IncomingMessage['headers'] }):
    { peer: { principal: { kind: string } } } | { rejection: number };
}

export function deviceProxy(connection: DeviceConnection, endpoint: string, token: string) {
  const target = new URL(endpoint);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' || target.search || target.username || target.password) throw new Error('Device admin must use loopback');
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const admission = connection.admit(req);
    const rejection = 'rejection' in admission ? admission.rejection : admission.peer.principal.kind === 'owner' ? undefined : 403;
    if (rejection) { res.writeHead(rejection).end(); return; }
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405).end(); return; }
    const path = new URL(req.url ?? '/', 'http://localhost');
    const prefix = '/swiftnest/api/devices';
    if (path.pathname !== prefix && !path.pathname.startsWith(prefix + '/')) { res.writeHead(404).end(); return; }
    const abort = new AbortController();
    const closed = () => abort.abort();
    res.once('close', closed);
    try {
      const upstream = await fetch(new URL(path.pathname + path.search, target), {
        method: req.method,
        // Never forward cookies, browser headers, arbitrary authorization, or request bodies.
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
        redirect: 'error',
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store', 'x-accel-buffering': 'no',
      });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res);
      else res.end();
    } catch {
      if (!abort.signal.aborted) {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      }
    } finally { res.off('close', closed); }
  };
}
