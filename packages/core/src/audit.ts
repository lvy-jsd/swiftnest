/**
 * Append-only audit log. Every task state change lands here with the raw arguments, so a person can always
 * see exactly what an agent asked a device to do. Plugins get no handle to rewrite it.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "@swiftnest/protocol";

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
      await appendFile(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    });
    return this.queue;
  }
  async query(q?: AuditQuery) {
    await this.queue;
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const entries = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
    return filter(entries, q);
  }
}
