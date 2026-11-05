import type { IncomingMessage, ServerResponse } from 'node:http';
import { localizedError, text, type Language } from '@swiftnest/protocol';
import type { DeviceConnection } from '../devices.js';
import { ServerFailure } from '../memory/failure.js';
import type { ChatSearch } from './service.js';

export const SEARCH_PREFIX = '/swiftnest/api/search';
export function searchHandler(connection: DeviceConnection, service: ChatSearch) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const admission = connection.admit(req);
    const rejection =
      'rejection' in admission ? admission.rejection : admission.peer.principal.kind !== 'owner' ? 403 : undefined;
    if (rejection) {
      res.writeHead(rejection).end();
      return;
    }
    const lang: Language = req.headers['accept-language']?.startsWith('en') ? 'en' : 'zh-CN';
    try {
      const value = await route(service, req);
      send(res, 200, value);
    } catch (error) {
      const failure = error instanceof ServerFailure ? error : new ServerFailure(text('chatSearchFailed'));
      send(res, failure.text?.key === 'chatSearchDisabled' ? 503 : 400, {
        ...failure.toJSON(),
        ...localizedError(failure, lang),
      });
    }
  };
}
async function route(service: ChatSearch, req: IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.slice(SEARCH_PREFIX.length);
  if (req.method === 'GET' && path === '')
    return service.search(url.searchParams.get('query') ?? '', Number(url.searchParams.get('limit') ?? 20));
  if (req.method === 'GET' && path === '/status') return service.status();
  if (req.method === 'POST' && path === '/rebuild') return service.rebuild();
  if (req.method === 'POST' && path === '/settings') return service.configure(await readSettings(req));
  throw new ServerFailure(text('chatSearchInvalidQuery'));
}
async function readSettings(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new ServerFailure(text('chatSearchInvalidSettings'));
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ServerFailure(text('invalidJsonBody'));
  }
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}
