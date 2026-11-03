import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { text } from '@swiftnest/protocol';
import { ServerFailure } from './failure.js';
import { memoryRules } from './rules.js';

export interface PendingMemory {
  id: string;
  time: string;
  files: Record<string, string>;
}

export function validTopic(value: unknown): string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(value))
    throw new ServerFailure(text('memoryInvalidTopic'));
  return value;
}

export function memoryDirectory(root: string, directory: 'topics' | 'snapshots'): string {
  const path = join(root, directory);
  for (const candidate of [root, path]) {
    if (isDanglingLink(candidate)) throw new ServerFailure(text('memoryInvalidData'));
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function memoryFiles(root: string, directory: 'topics' | 'snapshots'): string[] {
  return readdirSync(memoryDirectory(root, directory))
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      memoryPath(root, `${directory}/${file}`);
      return `${directory}/${file}`;
    });
}

export function removeMemoryFile(root: string, file: string): void {
  const path = memoryPath(root, file);
  if (!existsSync(path)) return;
  unlinkSync(path);
  sync(dirname(path));
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

/** Keep transaction ids for replay deduplication, never historical document text.
 * Old-format rows are reduced to their commit marker; a torn tail needs no replay data. */
export function repairJournal(root: string): void {
  const journal = readMemoryFile(root, 'journal.jsonl');
  const rows: string[] = [];
  for (const line of journal.split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line) as { id: string; time: string };
      if (typeof row.id !== 'string' || typeof row.time !== 'string') throw new Error('invalid journal');
      rows.push(JSON.stringify({ id: row.id, time: row.time }));
    } catch {
      // Even an old partially written before/after field must not survive in journal.torn.
      // Discard the incomplete record; pending.json owns all replay data.
    }
  }
  const recent = rows.slice(-memoryRules.journalRows);
  const repaired = recent.length ? `${recent.join('\n')}\n` : '';
  if (journal !== repaired) atomicMemoryFile(root, 'journal.jsonl', repaired);
  removeMemoryFile(root, 'journal.torn');
}

/** Abandoned atomic-write files are never a hidden backup of previous text. */
export function cleanMemoryTemps(root: string): void {
  const directories = ['', 'topics', 'snapshots'] as const;
  for (const directory of directories) {
    const path = directory ? memoryDirectory(root, directory) : root;
    for (const file of readdirSync(path)) {
      if (!file.endsWith('.tmp')) continue;
      const relative = directory ? `${directory}/${file.slice(0, -4)}` : file.slice(0, -4);
      const target = memoryPath(root, relative);
      unlinkSync(`${target}.tmp`);
      sync(path);
    }
  }
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
      Array.isArray(pending.files)
    )
      throw 0;
    for (const [file, content] of Object.entries(pending.files)) {
      if (file !== 'MEMORY.md' && !/^(topics|snapshots)\/[^/]+\.md$/.test(file)) throw 0;
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
    appendMemoryFile(root, 'journal.jsonl', `${JSON.stringify({ id: pending.id, time: pending.time })}\n`);
    step?.('journal.appended');
    // There is only one pending transaction; its marker is newest until pending.json is removed.
    repairJournal(root);
    step?.('journal.jsonl');
  }
  unlinkSync(memoryPath(root, 'pending.json'));
  sync(root);
  step?.('committed');
}
