import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { HttpError, readBody, readJsonObject } from '../src/http.js';

const request = (...chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;

describe('readBody', () => {
  it('keeps a multi-byte character that is split across chunks', async () => {
    const bytes = Buffer.from('{"text":"设备"}');
    const split = bytes.indexOf(Buffer.from('设')) + 1;
    expect(await readBody(request(bytes.subarray(0, split), bytes.subarray(split)), 1024, 'too large')).toBe('{"text":"设备"}');
  });

  it('stops at the limit with a 413', async () => {
    await expect(readBody(request(Buffer.alloc(600), Buffer.alloc(600)), 1024, 'too large')).rejects.toMatchObject({
      status: 413,
      message: 'too large',
    });
  });
});

describe('readJsonObject', () => {
  it.each(['not json', '[1,2]', 'null', '"text"'])('rejects %s with a 400', async (body) => {
    const failure = await readJsonObject(request(Buffer.from(body)), 1024, 'too large').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ status: 400 });
  });

  it('returns an object body', async () => {
    expect(await readJsonObject(request(Buffer.from('{"a":1}')), 1024, 'too large')).toEqual({ a: 1 });
  });
});
