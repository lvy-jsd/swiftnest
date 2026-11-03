import { createHash } from 'node:crypto';

import type { MemoryEntry } from '@swiftnest/protocol';
export type { MemoryEntry } from '@swiftnest/protocol';

export interface MemoryDocument {
  lines: string[];
  entries: MemoryEntry[];
  topics: string[];
}

/** Preserve document bytes, including metadata we do not own, on a format round trip. */
export function parseMemory(content: string, topic?: string): MemoryDocument {
  const lines = content.split('\n');
  const entries: MemoryEntry[] = [];
  const topics: string[] = [];
  let index = false;
  for (const line of lines) {
    if (line.startsWith('## ')) index = line === '## Index';
    const link = index ? /^- \[\[([^\]]+)\]\]$/.exec(line) : null;
    if (link) topics.push(link[1]!);
    const match = /^- (.+) \[source: ([^;\]]*); added: ([^;\]]*)(?:; id: ([^;\]]+))?\]$/.exec(line);
    if (!match) continue;
    const id =
      match[4] ??
      createHash('sha256')
        .update(`${topic ?? ''}\n${line}`)
        .digest('hex');
    entries.push({ id, text: match[1]!, source: match[2]!, added: match[3]!, topic, line });
  }
  return { lines, entries, topics };
}

export function serializeMemory(document: MemoryDocument): string {
  return document.lines.join('\n');
}

export function entryLine(text: string, source: string, id: string, added = new Date().toISOString()): string {
  return `- ${text} [source: ${source}; added: ${added}; id: ${id}]`;
}

export function indexDocument(entries: string[], topics: string[]): string {
  return ['# Memory', '', ...entries, '', '## Index', ...topics.map((topic) => `- [[${topic}]]`), ''].join('\n');
}
