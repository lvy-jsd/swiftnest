/** Small HTTP helpers shared by the loopback device API. */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorCodeFor, isText, SwiftnestFailure, text, type SwiftnestError, type Text } from '@swiftnest/core';

/** A failure the router answers with this status and the failure's wire form. */
export class HttpError extends Error {
  readonly failure: SwiftnestError;

  constructor(
    readonly status: number,
    failure: Text | SwiftnestError,
  ) {
    const wire = isText(failure) ? new SwiftnestFailure(errorCodeFor(failure.key), failure).toJSON() : failure;
    super(wire.message);
    this.failure = wire;
  }
}

/** True when the request carries exactly `Bearer <token>`, compared in constant time. */
export function hasBearer(req: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(req.headers.authorization ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Read the body as UTF-8, stopping at `limit` bytes. Chunks are joined before decoding, so a
 * multi-byte character split across two chunks stays intact.
 */
export async function readBody(req: IncomingMessage, limit: number, tooLarge: Text): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a JSON object body; anything else is a 400. */
export async function readJsonObject(
  req: IncomingMessage,
  limit: number,
  tooLarge: Text,
): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit, tooLarge);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpError(400, text('invalidJsonBody'));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, text('invalidJsonBody'));
  return value as Record<string, unknown>;
}

/** Start a server-sent event stream, register it in `streams` until it closes, and send `first`. */
export function openEventStream(res: ServerResponse, streams: Set<ServerResponse>, first: unknown): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  streams.add(res);
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    streams.delete(res);
  });
}
