import type { IncomingMessage, ServerResponse } from 'node:http';
import { render, text } from '@swiftnest/protocol';
import { liveTransportAllowed, type DeviceConnection } from './devices.js';
import type { ServerRelay } from './relay.js';

async function updateRelay(req: IncomingMessage, res: ServerResponse, relay: ServerRelay): Promise<boolean> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2048) throw new Error('Too large');
      chunks.push(chunk);
    }
    await relay.save(JSON.parse(Buffer.concat(chunks).toString()));
    return true;
  } catch {
    res
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ message: render(text('relayInvalidSettings')), text: text('relayInvalidSettings') }));
    return false;
  }
}

/** Owner admission also applies inside Noise. GET never returns a secret over ordinary HTTP. */
export function relaySettings(relay: ServerRelay, connection: DeviceConnection, origin: () => string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('cache-control', 'no-store');
    const admission = connection.admit(req);
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') {
      res.writeHead('rejection' in admission ? admission.rejection : 403).end();
      return;
    }
    if (!liveTransportAllowed(req)) {
      res.writeHead(426).end();
      return;
    }
    if (req.url === '/swiftnest/relay/connection') {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          pairing: relay.pairing(new URL('/', origin()).href),
          relaySecret: relay.config?.secret,
        }),
      );
      return;
    }
    if (req.method === 'POST') {
      if (!(await updateRelay(req, res, relay))) return;
    } else if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        address: relay.config?.address ?? '',
        connected: relay.connected,
      }),
    );
  };
}
