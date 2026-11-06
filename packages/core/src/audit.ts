/**
 * Append-only audit log. Every task state change lands here with the raw arguments, so a person can always
 * see exactly what an agent asked a device to do. Plugins get no handle to rewrite it.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEntry } from '@swiftnest/protocol';

export interface AuditQuery {
  taskId?: string;
  device?: string;
  /** Most recent N entries (default 100). */
  limit?: number;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  query(q?: AuditQuery): Promise<AuditEntry[]>;
}

function filter(entries: AuditEntry[], q: AuditQuery = {}): AuditEntry[] {
  const hit = entries.filter((e) => (!q.taskId || e.taskId === q.taskId) && (!q.device || e.device === q.device));
  return hit.slice(-(q.limit ?? 100));
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async append(entry: AuditEntry) {
    this.entries.push(structuredClone(entry));
  }
  async query(q?: AuditQuery) {
    return filter(this.entries, q);
  }
}

/**
 * Audit is a log, not a payload store. A 200 KB `content` argument used to be
 * written verbatim — four times per call (queued, waiting, running, done), which
 * quietly costs hundreds of megabytes for one large write. Long strings are
 * truncated with their original length kept, so the line still says what
 * happened and how much was involved.
 */
const MAX_ARG_CHARS = 2048;
export function trimArgs(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > MAX_ARG_CHARS
      ? `${value.slice(0, MAX_ARG_CHARS)}…[truncated ${value.length - MAX_ARG_CHARS} chars]`
      : value;
  if (Array.isArray(value)) return value.map(trimArgs);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = trimArgs(inner);
    return out;
  }
  return value;
}

/** One JSON object per line; survives restarts and is easy to inspect with standard tools. */
export class JsonlAuditLog implements AuditLog {
  private ready: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {
    this.ready = mkdir(dirname(path), { recursive: true }).then(() => undefined);
  }
  append(entry: AuditEntry) {
    // serialize writes so concurrent tasks never interleave lines
    this.queue = this.queue.then(async () => {
      await this.ready;
      await appendFile(this.path, `${JSON.stringify({ ...entry, args: trimArgs(entry.args) })}\n`, { mode: 0o600 });
    });
    return this.queue;
  }
  async query(q?: AuditQuery) {
    await this.queue;
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const entries = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
    return filter(entries, q);
  }
}
