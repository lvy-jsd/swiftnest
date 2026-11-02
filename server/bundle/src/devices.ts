import { WebSocket, WebSocketServer } from 'ws';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Use the kernel's own signed-session and Host/Origin admission, including owner scope. */
export interface DeviceConnection {
  admit(request: { headers: IncomingMessage['headers'] }):
    { peer: { principal: { kind: string } } } | { rejection: number };
}

/** TLS may terminate in the kernel or a trusted local reverse proxy. Never trust a browser forwarded-proto header. */
export function liveTransportAllowed(req: Pick<IncomingMessage,'socket'>): boolean {
  return Boolean((req.socket as import('node:tls').TLSSocket).encrypted) || ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
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
    if (path.pathname===`${prefix}/live` && !liveTransportAllowed(req)) { res.writeHead(426).end(); return; }
    const abort = new AbortController();
    const closed = () => abort.abort();
    res.once('close', closed);
    try {
      let body: string | undefined;
      if (req.method === 'POST' && [`${prefix}/transfers`, `${prefix}/preferences`].includes(path.pathname)) {
        body='';for await(const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>32768){res.writeHead(413).end();return;}}
      }
      const upstream = await fetch(new URL(path.pathname + path.search, target), {
        method: req.method,
        // Only the bounded transfer JSON body is forwarded, after owner admission.
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : {"content-type":"application/json"}) },
        body,
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

/** Both admission and the parent admin bearer are required. No public stream ticket bypasses owner admission. */
export function liveUpgrade(connection: DeviceConnection, endpoint: string, token: string) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const admission = connection.admit(req);
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (!liveTransportAllowed(req)) return socket.destroy();
    const target = new URL(endpoint);
    if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') return socket.destroy();
    const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id');
    if (!id || !/^[a-f0-9]{32}$/.test(id)) return socket.destroy();
    target.protocol = 'ws:'; target.pathname = '/swiftnest/api/devices/live'; target.search = new URLSearchParams({id}).toString();
    const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${token}` }, maxPayload: 4194350, handshakeTimeout: 10000 });
    const abort = () => { upstream.terminate(); socket.destroy(); };
    upstream.once('error', abort);socket.once('close', () => upstream.terminate());
    upstream.once('open', () => wss.handleUpgrade(req, socket, head, app => {
      const close = () => { app.terminate(); upstream.terminate(); };
      app.on('message', (data, binary) => { if (!binary || upstream.bufferedAmount > 131072) return close(); upstream.send(data, {binary:true}); });
      upstream.on('message', (data, binary) => { if (!binary || app.bufferedAmount > 8388608) return close(); app.send(data, {binary:true}); });
      for (const peer of [app, upstream]) { peer.on('error', close); peer.on('close', close); }
    }));
  };
  return { handler, close: () => { for (const peer of wss.clients) peer.terminate(); wss.close(); } };
}
