import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, loadConfig, type ModelConfig } from '../src/config.js';
import { probeLocalModel, withLocalFacts } from '../src/model-probe.js';

/** A fake local server answering only `routes`; everything else is 404. */
async function server(routes: Record<string, (req: IncomingMessage) => unknown>) {
  const seen: { url: string; auth?: string; body: string }[] = [];
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    seen.push({ url: req.url!, auth: req.headers.authorization, body });
    const route = routes[`${req.method} ${req.url}`];
    if (!route) return void res.writeHead(404).end();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(route(req)));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => http.close(() => resolve()));
  return { seen, close, model: (id: string): ModelConfig => ({ ...DEFAULT_MODEL, id, baseUrl: `${root}/v1` }) };
}

async function detect(routes: Record<string, (req: IncomingMessage) => unknown>, id = 'm', env = {}) {
  const fake = await server(routes);
  try {
    const facts = await probeLocalModel(fake.model(id), env);
    return { context: facts.contextWindow, vision: facts.vision, seen: fake.seen };
  } finally {
    await fake.close();
  }
}

describe('local model detection', () => {
  it('reads each common local server', async () => {
    const vllm = {
      'GET /v1/models': () => ({
        data: [
          { id: 'other', max_model_len: 4096 },
          { id: 'm', max_model_len: 65536 },
        ],
      }),
    };
    expect((await detect(vllm)).context).toBe(65536);
    const tabby = { 'GET /v1/model': () => ({ id: 'm', parameters: { max_seq_len: 131072 } }) };
    expect((await detect(tabby)).context).toBe(131072);
    const llama = { 'GET /props': () => ({ default_generation_settings: { n_ctx: 16384 } }) };
    expect((await detect(llama)).context).toBe(16384);
    const ollama = { 'GET /api/ps': () => ({ models: [{ name: 'qwen3:latest', context_length: 8192 }] }) };
    expect((await detect(ollama, 'qwen3')).context).toBe(8192);
    const modelfile = { 'POST /api/show': () => ({ parameters: 'temperature 0.7\nnum_ctx 40960' }) };
    expect((await detect(modelfile)).context).toBe(40960);
    const lmStudio = { 'GET /api/v0/models/m': () => ({ loaded_context_length: 24576, max_context_length: 131072 }) };
    expect((await detect(lmStudio)).context).toBe(24576);
  });

  it('prefers what the running server allocated and ignores nonsense', async () => {
    const both = {
      'GET /v1/model': () => ({ parameters: { max_seq_len: 'lots' } }),
      'GET /props': () => ({ n_ctx: 12288 }),
      'GET /api/show': () => ({ parameters: 'num_ctx 99' }),
    };
    expect((await detect(both)).context).toBe(12288);
    expect((await detect({})).context).toBeUndefined();
  });

  it('learns whether the model reads images', async () => {
    const ollama = { 'POST /api/show': () => ({ capabilities: ['completion', 'vision'] }) };
    expect((await detect(ollama)).vision).toBe(true);
    const llama = { 'GET /props': () => ({ n_ctx: 8192, modalities: { vision: false } }) };
    expect(await detect(llama)).toMatchObject({ context: 8192, vision: false });
    const lmStudio = { 'GET /api/v0/models/m': () => ({ type: 'vlm' }) };
    expect((await detect(lmStudio)).vision).toBe(true);
    const tabby = { 'GET /v1/model': () => ({ id: 'm', parameters: { max_seq_len: 131072, use_vision: true } }) };
    expect(await detect(tabby)).toMatchObject({ context: 131072, vision: true });
    const catalog = {
      'GET /v1/models': () => ({ data: [{ id: 'm', architecture: { input_modalities: ['text', 'image'] } }] }),
    };
    expect((await detect(catalog)).vision).toBe(true);
    expect((await detect({})).vision).toBeUndefined();
  });

  it('sends the local key when one is set', async () => {
    const { seen } = await detect({}, 'm', { SWIFTNEST_MODEL_API_KEY: 'local-key' });
    expect(seen.every((request) => request.auth === 'Bearer local-key')).toBe(true);
    expect(seen.find((request) => request.url === '/api/show')?.body).toBe('{"model":"m"}');
  });

  it('fills in only what the owner did not set, capping output to a quarter of a detected window', async () => {
    const fake = await server({ 'GET /props': () => ({ n_ctx: 8192, modalities: { vision: true } }) });
    try {
      const both = { ...fake.model('m'), detect: { contextWindow: true, vision: true } } as const;
      expect(await withLocalFacts(both, {})).toMatchObject({ contextWindow: 8192, maxTokens: 2048, vision: true });
      const visionOnly = { ...fake.model('m'), contextWindow: 4096, detect: { vision: true } } as const;
      expect(await withLocalFacts(visionOnly, {})).toMatchObject({ contextWindow: 4096, vision: true });
      const fixed = { ...fake.model('m'), contextWindow: 4096 };
      expect(await withLocalFacts(fixed, {})).toBe(fixed);
    } finally {
      await fake.close();
    }
  });
});

describe('local model config', () => {
  it('detects what neither the file nor the environment sets', () => {
    expect(loadConfig(undefined, {}).model).toMatchObject({
      contextWindow: 32768,
      vision: false,
      detect: { contextWindow: true, vision: true },
    });
    const set = loadConfig(undefined, {
      SWIFTNEST_MODEL_CONTEXT_WINDOW: '131072',
      SWIFTNEST_MODEL_VISION: 'true',
    }).model;
    expect(set).toMatchObject({ contextWindow: 131072, vision: true });
    expect(set.detect).toBeUndefined();
    expect(() => loadConfig(undefined, { SWIFTNEST_MODEL_CONTEXT_WINDOW: '12.5' })).toThrow('contextWindow');
    expect(() => loadConfig(undefined, { SWIFTNEST_MODEL_VISION: 'yes' })).toThrow('model.vision');
  });
});
