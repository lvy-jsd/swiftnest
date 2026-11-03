import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { text } from '@swiftnest/protocol';
import { ServerFailure } from './failure.js';

export interface MemoryChange {
  file: string;
  before: string | null;
  after: string | null;
}
export interface PendingMemory {
  id: string;
  time: string;
  files: Record<string, string>;
  changes: MemoryChange[];
}

export function validTopic(value: unknown): string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(value))
    throw new ServerFailure(text('memoryInvalidTopic'));
  return value;
}

/** Only explicitly owned paths are admitted; symlinks cannot redirect the store. */
export function memoryPath(root: string, relative: string): string {
  const parts = relative.split('/');
  const allowed =
    ['MEMORY.md', 'journal.jsonl', 'journal.torn', 'pending.json'].includes(relative) ||
    (parts.length === 2 &&
      ['topics', 'snapshots'].includes(parts[0]!) &&
      parts[1]!.endsWith('.md') &&
      /^[\p{L}\p{N}][\p{L}\p{N} _.-]*\.md$/u.test(parts[1]!));
  if (!allowed) throw new ServerFailure(text('memoryInvalidData'));
  for (const path of [root, ...parts.map((_, i) => join(root, ...parts.slice(0, i + 1)))]) {
    if (existsSync(path) ? lstatSync(path).isSymbolicLink() : isDanglingLink(path))
      throw new ServerFailure(text('memoryInvalidData'));
  }
  return join(root, relative);
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function readMemoryFile(root: string, file: string): string {
  const path = memoryPath(root, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function sync(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicMemoryFile(root: string, file: string, content: string): void {
  const path = memoryPath(root, file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  // Never follow a pre-existing temporary symlink.
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  sync(temporary);
  renameSync(temporary, path);
  sync(dirname(path));
}

export function appendMemoryFile(root: string, file: string, content: string): void {
  const path = memoryPath(root, file);
  appendFileSync(path, content, { mode: 0o600 });
  sync(path);
  sync(dirname(path));
}

/** A valid unterminated JSON row is complete; an invalid tail is preserved before truncation. */
export function repairJournal(root: string): void {
  const journal = readMemoryFile(root, 'journal.jsonl');
  if (!journal || journal.endsWith('\n')) return;
  const boundary = journal.lastIndexOf('\n') + 1;
  const tail = journal.slice(boundary);
  try {
    JSON.parse(tail);
  } catch {
    const torn = readMemoryFile(root, 'journal.torn');
    atomicMemoryFile(root, 'journal.torn', torn.endsWith(`${tail}\n`) ? torn : `${torn}${tail}\n`);
    atomicMemoryFile(root, 'journal.jsonl', journal.slice(0, boundary));
    return;
  }
  atomicMemoryFile(root, 'journal.jsonl', `${journal}\n`);
}

export function readPending(root: string): PendingMemory | undefined {
  const raw = readMemoryFile(root, 'pending.json');
  if (!raw) return;
  try {
    const pending = JSON.parse(raw) as PendingMemory;
    if (
      !pending ||
      typeof pending.id !== 'string' ||
      typeof pending.time !== 'string' ||
      !pending.files ||
      typeof pending.files !== 'object' ||
      Array.isArray(pending.files) ||
      !Array.isArray(pending.changes)
    )
      throw 0;
    for (const [file, content] of Object.entries(pending.files)) {
      if (file !== 'MEMORY.md' && !/^topics\/[^/]+\.md$/.test(file)) throw 0;
      if (file.startsWith('topics/')) validTopic(file.slice(7, -3));
      memoryPath(root, file);
      if (typeof content !== 'string') throw 0;
    }
    return pending;
  } catch {
    throw new ServerFailure(text('memoryInvalidData'));
  }
}

export function applyPending(root: string, pending: PendingMemory, step?: (name: string) => void): void {
  // A committed transaction must never overwrite later state or append its journal row twice.
  const committed = readMemoryFile(root, 'journal.jsonl')
    .split('\n')
    .filter(Boolean)
    .some((line) => (JSON.parse(line) as { id: string }).id === pending.id);
  if (!committed) {
    for (const [file, content] of Object.entries(pending.files)) {
      atomicMemoryFile(root, file, content);
      step?.(file);
    }
    appendMemoryFile(
      root,
      'journal.jsonl',
      `${JSON.stringify({ id: pending.id, time: pending.time, changes: pending.changes })}\n`,
    );
    step?.('journal.jsonl');
  }
  unlinkSync(memoryPath(root, 'pending.json'));
  sync(root);
}
