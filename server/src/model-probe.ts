/**
 * What the local model can do: how much text it reads at once and whether it sees images.
 * Local servers know, but each says it differently, so ask the common ones at boot. A fixed
 * guess is wrong both ways: a 32K guess wastes a 128K model and overfills a 4K one, and a
 * vision model treated as text-only makes every photo need a cloud service.
 */
import type { ModelConfig } from './config.js';

const PROBE_TIMEOUT_MS = 2000;
/** Anything outside this range is a misread field, not a context window. */
const MIN_CONTEXT = 1024;
const MAX_CONTEXT = 100_000_000;

type Json = Record<string, unknown>;

/** `json.a.b…`, or undefined where any step is not an object. */
function get(json: unknown, ...path: string[]): unknown {
  let value = json;
  for (const key of path) value = value && typeof value === 'object' ? (value as Json)[key] : undefined;
  return value;
}
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** What one local server says about the model; any field may be missing. */
export interface ModelFacts {
  contextWindow?: number;
  /** The model reads images itself. */
  vision?: boolean;
}

interface Probe {
  /** Relative to the `/v1` base URL, or to the server root with a leading slash. */
  path: (id: string) => string;
  body?: (id: string) => object;
  read: (json: Json, id: string) => { contextWindow?: unknown; vision?: unknown };
}

const sameModel = (id: string) => (entry: Json) =>
  [entry.id, entry.name, entry.model].some((name) => name === id || name === `${id}:latest`);
const includes = (value: unknown, item: string) => (Array.isArray(value) ? value.includes(item) : undefined);

/** In order of trust: what the running server allocated beats what the model was trained for. */
const PROBES: readonly Probe[] = [
  // vLLM (`max_model_len`), OpenRouter-style catalogs (`context_length`, input modalities).
  {
    path: () => 'models',
    read: (json, id) => {
      const entry = list(json.data).find(sameModel(id));
      return {
        contextWindow: entry?.max_model_len ?? entry?.context_length ?? entry?.context_window,
        vision: includes(get(entry, 'architecture', 'input_modalities'), 'image'),
      };
    },
  },
  // TabbyAPI: the loaded model's card.
  { path: () => 'model', read: (json) => ({ contextWindow: get(json, 'parameters', 'max_seq_len') }) },
  // llama.cpp server: the slot context it was started with, and whether a projector is loaded.
  {
    path: () => '/props',
    read: (json) => ({
      contextWindow: get(json, 'default_generation_settings', 'n_ctx') ?? json.n_ctx,
      vision: get(json, 'modalities', 'vision'),
    }),
  },
  // Ollama: a loaded model's context, else the model file's `num_ctx`; capabilities name vision.
  {
    path: () => '/api/ps',
    read: (json, id) => ({ contextWindow: list(json.models).find(sameModel(id))?.context_length }),
  },
  {
    path: () => '/api/show',
    body: (id) => ({ model: id }),
    read: (json) => ({
      contextWindow: /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(json.parameters ?? ''))?.[1],
      vision: includes(json.capabilities, 'vision'),
    }),
  },
  // LM Studio's native API.
  {
    path: (id) => `/api/v0/models/${encodeURIComponent(id)}`,
    read: (json) => ({
      contextWindow: json.loaded_context_length ?? json.max_context_length,
      vision: typeof json.type === 'string' ? json.type === 'vlm' : undefined,
    }),
  },
];

function validContext(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_CONTEXT && n <= MAX_CONTEXT ? n : undefined;
}

function probeUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return path.startsWith('/') ? `${base.replace(/\/v1$/, '')}${path}` : `${base}/${path}`;
}

async function ask(model: ModelConfig, probe: Probe, key: string | undefined, fetchImpl: typeof fetch) {
  const body = probe.body?.(model.id);
  const response = await fetchImpl(probeUrl(model.baseUrl, probe.path(model.id)), {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { authorization: `Bearer ${key}`, 'x-api-key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) return {};
  const facts = probe.read((await response.json()) as Json, model.id);
  return {
    contextWindow: validContext(facts.contextWindow),
    vision: typeof facts.vision === 'boolean' ? facts.vision : undefined,
  };
}

/** What the local server says about its model; nothing when no known server answers. */
export async function probeLocalModel(
  model: ModelConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelFacts> {
  const key = env[model.apiKeyEnv] || undefined;
  const answers = await Promise.all(PROBES.map((probe) => ask(model, probe, key, fetchImpl).catch(() => ({}))));
  const first = <K extends keyof ModelFacts>(field: K) =>
    answers.map((answer: ModelFacts) => answer[field]).find((value) => value !== undefined);
  const contextWindow = first('contextWindow');
  const vision = first('vision');
  return { ...(contextWindow ? { contextWindow } : {}), ...(vision === undefined ? {} : { vision }) };
}

/** `model` with what the local server reports, for whatever the owner did not set. */
export async function withLocalFacts(model: ModelConfig, env?: NodeJS.ProcessEnv): Promise<ModelConfig> {
  if (!model.detect) return model;
  const facts = await probeLocalModel(model, env);
  const contextWindow = model.detect.contextWindow ? facts.contextWindow : undefined;
  const vision = model.detect.vision ? facts.vision : undefined;
  return {
    ...model,
    ...(contextWindow ? { contextWindow, maxTokens: Math.min(model.maxTokens, Math.floor(contextWindow / 4)) } : {}),
    ...(vision === undefined ? {} : { vision }),
  };
}
