/** Downloads use the same default-deny guard as server → phone transfers. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { text } from '@swiftnest/core';
import { HttpError } from './http.js';
import type { FileStorage } from './file-storage.js';

const mediaTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.mid': 'audio/midi',
  '.srt': 'application/x-subrip',
};
export async function downloadFile(storage: FileStorage, path: string, res: ServerResponse): Promise<void> {
  try {
    const allowed = await storage.allowed(path);
    const info = await stat(allowed);
    if (!info.isFile()) throw new Error();
    res.writeHead(200, {
      'content-type': mediaTypes[extname(allowed)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    await pipeline(createReadStream(allowed), res);
  } catch {
    if (res.headersSent) res.destroy();
    else throw new HttpError(404, text('notFound'));
  }
}
