import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import type { ChatSearchSettings } from '@swiftnest/protocol';
import type { VectorStore } from './vectors.js';

interface Endpoint {
  url: string;
  model: string;
  key?: string;
  source: 'local' | 'cloud';
}
export interface EmbeddingConfig {
  home: string;
  localBaseUrl: string;
  localModel: string;
  localApiKey?: string;
}

/** No DNS-derived trust and no redirects: a remote model URL is never treated as local. */
export function isLocalEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      !url.username &&
      !url.password &&
      ['http:', 'https:'].includes(url.protocol) &&
      ((isIP(host) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
        host === '[::1]' ||
        host === 'localhost')
    );
  } catch {
    return false;
  }
}

/** One serialized request lane for background batches and semantic queries. */
export class Embeddings {
  active: Endpoint | null = null;
  private generation = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private job?: Promise<void>;
  private requests: Promise<unknown> = Promise.resolve();
  private abort = new AbortController();
  constructor(
    private config: EmbeddingConfig,
    private vectors: VectorStore,
    private settings: () => ChatSearchSettings,
  ) {}
  start(delay = 250) {
    if (this.closed) return;
    if (this.timer && delay > 250) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.job) return;
      this.job = this.work()
        .catch(() => {
          this.active = null;
        })
        .finally(() => {
          this.job = undefined;
          this.start(60_000);
        });
    }, delay);
    this.timer.unref();
  }
  changed() {
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.active = null;
    this.vectors.reset();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // A superseded request must finish before the next background job starts.
    void (this.job ?? Promise.resolve()).finally(() => this.start(0));
  }
  close() {
    this.closed = true;
    this.generation += 1;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
  }
  async search(query: string): Promise<number[]> {
    const endpoint = this.active;
    const generation = this.generation;
    if (!endpoint || !this.allowed()) return [];
    try {
      const [vector] = await this.embed(endpoint, [query]);
      return generation === this.generation && !this.closed ? this.vectors.search(identity(endpoint), vector!) : [];
    } catch {
      if (generation === this.generation) this.active = null;
      return [];
    }
  }
  current() {
    return this.allowed() ? this.active : null;
  }
  private allowed() {
    const settings = this.settings();
    return (
      settings.enabled &&
      settings.semantic &&
      (settings.embeddings.source === 'local' || (settings.embeddings.cloudConsent && Boolean(this.cloudKey())))
    );
  }
  private cloudKey(): string | undefined {
    try {
      const key = JSON.parse(readFileSync(join(this.config.home, 'model-keys.json'), 'utf8')).openai;
      return typeof key === 'string' && key.length >= 8 ? key : undefined;
    } catch {
      return undefined;
    }
  }
  private async endpoint(): Promise<Endpoint | null> {
    if (!this.allowed()) return null;
    const { embeddings } = this.settings();
    if (embeddings.source === 'cloud')
      return {
        source: 'cloud',
        url: 'https://api.openai.com/v1',
        model: embeddings.model ?? 'text-embedding-3-small',
        key: this.cloudKey(),
      };
    if (!isLocalEndpoint(this.config.localBaseUrl)) return null;
    let model = embeddings.model;
    if (!model) {
      try {
        const response = await fetch(`${this.config.localBaseUrl.replace(/\/$/, '')}/models`, {
          redirect: 'error',
          headers: authorization(this.config.localApiKey),
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(3000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return this.localEndpoint(this.config.localModel);
        }
        const body = (await response.json()) as { data?: { id: string }[] };
        model = body.data?.find((item) => /embed|bge|\be5\b|nomic/i.test(item.id))?.id;
      } catch {
        /* A compatible server may omit model discovery. */
      }
    }
    return this.localEndpoint(model ?? this.config.localModel);
  }
  private localEndpoint(model: string): Endpoint {
    return {
      source: 'local',
      url: this.config.localBaseUrl.replace(/\/$/, ''),
      model,
      key: this.config.localApiKey,
    };
  }
  private async work() {
    const generation = this.generation;
    const endpoint = await this.endpoint();
    if (!endpoint || generation !== this.generation || this.closed) return;
    await this.embed(endpoint, ['search']);
    if (generation !== this.generation || this.closed) return;
    this.active = endpoint;
    const model = identity(endpoint);
    while (!this.closed && generation === this.generation && this.allowed()) {
      const batch = this.vectors.pending(model);
      if (!batch.length) break;
      const vectors = await this.embed(
        endpoint,
        batch.map((row) => row.text),
      );
      if (generation !== this.generation || this.closed) return;
      batch.forEach((row, index) => {
        this.vectors.put(row.id, model, vectors[index]!);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  private embed(endpoint: Endpoint, input: string[]): Promise<number[][]> {
    const generation = this.generation;
    const job = this.requests
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || this.closed || !this.allowed()) throw new Error('Embedding cancelled');
        const response = await fetch(`${endpoint.url}/embeddings`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            ...authorization(endpoint.source === 'cloud' ? this.cloudKey() : endpoint.key),
          },
          body: JSON.stringify({ model: endpoint.model, input }),
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Embeddings unavailable');
        }
        const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
        const rows = body.data?.sort((a, b) => a.index - b.index);
        if (
          !rows ||
          rows.length !== input.length ||
          rows.some((row, i) => row.index !== i || !validVector(row.embedding))
        )
          throw new Error('Invalid embeddings');
        if (rows.some((row) => row.embedding.length !== rows[0]!.embedding.length))
          throw new Error('Embedding dimensions');
        return rows.map((row) => row.embedding);
      });
    this.requests = job;
    return job;
  }
}
function authorization(key?: string): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}
function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8192 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e10)
  );
}
function identity(endpoint: Endpoint): string {
  return `${endpoint.source}:${endpoint.url}:${endpoint.model}`;
}
