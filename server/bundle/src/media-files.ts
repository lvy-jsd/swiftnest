/** Presentation references only: file reads still use the existing transfer storage guard. */
import { realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

export interface MediaFile {
  path: string;
  name: string;
}

export async function mediaFiles(text: string, outputDir: string): Promise<MediaFile[]> {
  const root = await realpath(outputDir).catch(() => undefined);
  if (!root) return [];
  const found = new Map<string, MediaFile>();
  for (const tail of text.split(outputDir + sep).slice(1)) {
    const name = tail.match(/^([\p{L}\p{N}_-]+\.(?:png|jpe?g|webp|gif|mp4|wav|mid|srt))(?=\s|$)/u)?.[1];
    if (!name) continue;
    const path = await realpath(join(outputDir, name)).catch(() => undefined);
    if (!path || path !== join(root, basename(name)) || !(await stat(path)).isFile()) continue;
    found.set(name, { path: `media/${name}`, name });
  }
  return [...found.values()];
}
