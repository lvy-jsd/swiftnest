import type { IncomingMessage, ServerResponse } from 'node:http';
import { localizedError, text, type Language } from '@swiftnest/protocol';
import type { DeviceConnection } from '../devices.js';
import { ServerFailure } from './failure.js';
import type { MemoryStore } from './store.js';

const prefix = '/swiftnest/api/memory';

export function memoryHandler(connection: DeviceConnection, store?: MemoryStore) {
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
      if (!store) throw new ServerFailure(text('memoryDisabled'));
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.slice(prefix.length);
      const value = await route(store, path, req, url);
      send(res, 200, value);
    } catch (error) {
      const failure = error instanceof ServerFailure ? error : new ServerFailure(text('memoryInvalidData'));
      const status = failure.text?.key === 'memoryNotFound' ? 404 : failure.text?.key === 'memoryDisabled' ? 503 : 400;
      send(res, status, { ...failure.toJSON(), ...localizedError(failure, lang) });
    }
  };
}

async function route(store: MemoryStore, path: string, req: IncomingMessage, url: URL) {
  if (req.method === 'GET') {
    if (path === '') return store.list();
    if (path === '/topic') return store.readTopic(url.searchParams.get('topic') ?? '');
    throw new ServerFailure(text('memoryNotFound'));
  }
  if (req.method !== 'POST') throw new ServerFailure(text('methodNotAllowed'));
  const body = await readBody(req);
  if (path === '/add') return store.remember(body.text, body.topic as string | undefined);
  if (path === '/edit') return store.edit(body.id as string, body.text);
  if (path === '/delete') return store.forget(body.id as string);
  if (path === '/topic') return store.writeTopic(body.topic as string, body.content);
  throw new ServerFailure(text('memoryNotFound'));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 131072) throw new ServerFailure(text('memoryRequestTooLarge'));
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new ServerFailure(text('invalidJsonBody'));
  }
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}
