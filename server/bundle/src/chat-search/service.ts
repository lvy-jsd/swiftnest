import { text, type ChatSearchSettings, type ChatSearchStatus } from '@swiftnest/protocol';
import { ServerFailure } from '../memory/failure.js';
import { ChatIndex, type SearchHeader, type SearchEvent } from './store.js';
import { Embeddings, type EmbeddingConfig } from './embeddings.js';
import { SqliteVectors } from './vectors.js';
import { searchSettings } from './settings.js';

export interface SearchSession {
  id: string;
  header: SearchHeader;
}
export interface SearchPersistence {
  list(): Promise<readonly { header: SearchHeader }[]>;
  open(
    id: string,
    access: 'read',
  ): Promise<{
    read(offset: number, length: number): Promise<{ events: readonly SearchEvent[] }>;
    close(): Promise<void>;
  }>;
}
export interface SearchSources {
  sessions: { list(): SearchSession[] };
  sessionPersistence: SearchPersistence;
}

/** The feed, catch-up, deletion and rebuild share one ordered lane. */
export class ChatSearch {
  readonly index: ChatIndex;
  readonly embeddings: Embeddings;
  private settings: ChatSearchSettings;
  private queue = Promise.resolve();
  private deleted = new Set<string>();
  private pendingSequences = new Map<string, number>();
  private retry?: ReturnType<typeof setTimeout>;
  private retryDelay = 250;
  private closed = false;
  private indexing = 0;
  private indexingFailed = false;
  constructor(
    private sources: SearchSources,
    config: EmbeddingConfig & { settings?: unknown },
  ) {
    this.index = new ChatIndex(config.home);
    this.settings = this.index.configuredSettings(searchSettings(config.settings ?? {}));
    this.embeddings = new Embeddings(config, new SqliteVectors(this.index.db), () => this.settings);
  }
  start() {
    return this.enqueue(() => this.catchUp());
  }
  event(session: SearchSession, event: SearchEvent) {
    if (session.header.origin === 'subagent' || this.deleted.has(session.id)) return;
    void this.enqueue(async () => {
      if (!this.settings.enabled || this.deleted.has(session.id)) return;
      if (event.seq > this.index.through(session.id) + 1) {
        this.pendingSequences.set(session.id, Math.max(event.seq, this.pendingSequences.get(session.id) ?? -1));
        await this.readSession(session.header);
      }
      if (this.deleted.has(session.id) || this.closed) return;
      this.index.consume(session.header, [event]);
      if (this.index.through(session.id) >= (this.pendingSequences.get(session.id) ?? -1))
        this.pendingSequences.delete(session.id);
      if (this.pendingSequences.size) this.retryCatchUp();
      else this.retryDelay = 250;
      this.embeddings.start();
    }).catch(() => {
      if (this.pendingSequences.size) this.retryCatchUp();
    });
  }
  dispose(session: SearchSession) {
    this.deleted.add(session.id);
    this.pendingSequences.delete(session.id);
    void this.enqueue(async () => this.index.deleteSession(session.id)).catch(() => {});
  }
  async search(query: unknown, limit: unknown = 20) {
    if (
      typeof query !== 'string' ||
      query.length > 1024 ||
      query.includes('\0') ||
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 50
    )
      throw new ServerFailure(text('chatSearchInvalidQuery'));
    await this.queue;
    if (!this.settings.enabled) throw new ServerFailure(text('chatSearchDisabled'));
    if (!query.trim()) return [];
    const semantic = await this.embeddings.search(query);
    if (this.closed) return [];
    if (!this.settings.enabled) throw new ServerFailure(text('chatSearchDisabled'));
    return this.index.results(query, limit as number, semantic).filter((row) => !this.deleted.has(row.sessionId));
  }
  status(): ChatSearchStatus {
    const active = this.settings.enabled && this.settings.semantic ? this.embeddings.current() : null;
    return {
      indexedMessages: this.index.count(),
      semantic: Boolean(active),
      embeddingSource: active?.source ?? null,
      embeddingModel: active?.model ?? null,
      indexing: this.indexing > 0,
      indexingFailed: this.indexingFailed,
      settings: structuredClone(this.settings),
    };
  }
  async configure(value: unknown) {
    const settings = searchSettings(value);
    return this.enqueue(async () => {
      this.index.saveSettings(settings);
      this.settings = settings;
      this.embeddings.changed();
      await this.catchUp();
      return this.status();
    });
  }
  rebuild() {
    return this.enqueue(async () => {
      this.embeddings.changed();
      this.index.rebuild();
      await this.catchUp();
      return this.status();
    });
  }
  async close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.embeddings.close();
    await this.queue;
    this.index.close();
  }
  private async catchUp() {
    if (!this.settings.enabled) return;
    const stored = await this.sources.sessionPersistence.list();
    const live = this.sources.sessions.list();
    const headers = new Map(
      [...stored.map((item) => item.header), ...live.map((item) => item.header)]
        .filter((header) => header.origin !== 'subagent' && !this.deleted.has(header.id))
        .map((header) => [header.id, header]),
    );
    this.index.prune(new Set(headers.keys()));
    for (const id of this.pendingSequences.keys()) {
      if (!headers.has(id)) this.pendingSequences.delete(id);
    }
    let failed = false;
    for (const header of headers.values()) {
      if (this.closed) return;
      try {
        await this.readSession(header);
        if (this.index.through(header.id) >= (this.pendingSequences.get(header.id) ?? -1))
          this.pendingSequences.delete(header.id);
      } catch {
        failed = true;
      }
    }
    this.indexingFailed = failed || this.pendingSequences.size > 0;
    if (this.pendingSequences.size) this.retryCatchUp();
    else this.retryDelay = 250;
    this.embeddings.start();
  }
  /** A live event may precede the persistence batching deadline. Never checkpoint past that gap. */
  private retryCatchUp() {
    if (this.retry || this.closed || !this.pendingSequences.size) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.start().catch(() => this.retryCatchUp());
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
    this.retry.unref();
  }
  private async readSession(header: SearchHeader) {
    if (this.deleted.has(header.id)) return;
    const handle = await this.sources.sessionPersistence.open(header.id, 'read');
    try {
      while (!this.closed && !this.deleted.has(header.id)) {
        const offset = this.index.through(header.id) + 1;
        const { events } = await handle.read(offset, 256);
        if (!events.length || this.deleted.has(header.id) || this.closed) break;
        this.index.consume(header, events);
        if (this.index.through(header.id) < offset) throw new Error('Session index gap');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    this.indexing += 1;
    const job = this.queue.then(() => {
      if (this.closed) throw new ServerFailure(text('chatSearchFailed'));
      return action();
    });
    this.queue = job
      .then(
        () => {},
        () => {
          this.indexingFailed = true;
        },
      )
      .finally(() => {
        this.indexing -= 1;
      });
    return job;
  }
}

export type { SearchEvent } from './store.js';
