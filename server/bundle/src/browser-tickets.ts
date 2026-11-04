import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DeviceConnection } from './devices.js';
import { liveTransportAllowed } from './devices.js';
import { normalizeChannelProxy, trustedProxyOrigin } from './trusted-proxy.js';

function sameOrigin(req: IncomingMessage, origin: string): boolean {
  const target = new URL(origin);
  return (
    normalizeChannelProxy(req, target) &&
    req.method === 'POST' &&
    req.headers.host === target.host &&
    (!req.headers.origin || req.headers.origin === target.origin) &&
    req.headers['sec-fetch-site'] !== 'cross-site' &&
    (liveTransportAllowed(req) ||
      (Boolean(trustedProxyOrigin()) && req.socket.remoteAddress === process.env.SWIFTNEST_TRUSTED_PROXY_IP))
  );
}

async function launchToken(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('Invalid sign-in');
    chunks.push(chunk);
  }
  const { token } = JSON.parse(Buffer.concat(chunks).toString());
  if (typeof token !== 'string' || !token || token.length > 2048) throw new Error('Invalid sign-in');
  return token;
}

/** Exchange only a launch token at the fixed local listener. The cookie never enters a JSON response. */
function exchange(origin: string, token: string): Promise<string[] | undefined> {
  const target = new URL('/', origin);
  target.searchParams.set('token', token);
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, (response) => {
      response.resume();
      resolve(response.statusCode === 303 ? response.headers['set-cookie'] : undefined);
    });
    request.setTimeout(5000, () => request.destroy());
    request.once('error', reject);
    request.end();
  });
}

/** A same-origin HttpOnly session opens Noise through a 30-second, single-use ticket. */
export class BrowserTickets {
  private tickets = new Map<string, { cookie: string; expires: number }>();
  signIn(origin: () => string) {
    return async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('cache-control', 'no-store');
      if (!sameOrigin(req, origin())) return void res.writeHead(403).end();
      try {
        const cookies = await exchange(origin(), await launchToken(req));
        if (!cookies?.length) return void res.writeHead(401).end();
        const proxyTls = req.socket.remoteAddress === process.env.SWIFTNEST_TRUSTED_PROXY_IP;
        res
          .writeHead(204, {
            'set-cookie': cookies.map((cookie) =>
              proxyTls && !/; Secure/i.test(cookie) ? `${cookie}; Secure` : cookie,
            ),
          })
          .end();
      } catch {
        res.writeHead(400).end();
      }
    };
  }
  consume(ticket: string): string | undefined {
    const record = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return record && record.expires > Date.now() ? record.cookie : undefined;
  }
  handler(connection: DeviceConnection, origin: () => string) {
    return (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('cache-control', 'no-store');
      if (!sameOrigin(req, origin())) {
        res.writeHead(403).end();
        return;
      }
      const admission = connection.admit(req);
      if ('rejection' in admission || admission.peer.principal.kind !== 'owner' || !req.headers.cookie) {
        res.writeHead(401).end();
        return;
      }
      for (const [key, value] of this.tickets) if (value.expires <= Date.now()) this.tickets.delete(key);
      if (this.tickets.size >= 128) {
        res.writeHead(429).end();
        return;
      }
      const ticket = randomUUID();
      this.tickets.set(ticket, { cookie: req.headers.cookie, expires: Date.now() + 30000 });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ticket }));
    };
  }
  close() {
    this.tickets.clear();
  }
}
