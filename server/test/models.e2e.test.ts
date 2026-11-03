/**
 * Boots the real pinned DSH kernel with an expert configured, against a scripted fake
 * model, and checks the whole hand-off: the main model is told about the expert, the
 * hand-off waits for the owner's approval, and the expert runs as a DSH subagent.
 * The expert here is the local fake model, so the test needs no cloud key.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { connect, type SwiftnestClient, type SwiftnestEvent } from '@swiftnest/api';
import { loadConfig } from '../src/config.js';
import type { RunningKernel } from '../src/kernel.js';
import { startStableKernel } from './fixtures/kernel.js';
import { pairingUrl } from '../src/pairing.js';
import { EXPERT_TOOL } from '../src/profile.js';

interface ModelRequest {
  stream?: boolean;
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}

/** A request the expert subagent made: its task is its user message. */
function fromExpert(request: ModelRequest): boolean {
  return request.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('expert-task'));
}

/** The main model hands `hand-off-*` prompts to the expert; the expert answers its task. */
function scriptedModel() {
  const requests: ModelRequest[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/models') return void res.end('{"data":[{"id":"fake"}]}');
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body) as ModelRequest;
    requests.push(request);
    if (!request.stream) return void res.end(JSON.stringify(completion('Expert test')));
    const handOff = !fromExpert(request) && !request.messages.some((m) => m.role === 'tool');
    stream(
      res,
      handOff ? { name: EXPERT_TOOL, arguments: { description: 'Expert test', prompt: 'expert-task' } } : undefined,
    );
  };
  return { requests, handle };
}

function completion(content: string) {
  return {
    id: 'fake',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function stream(res: ServerResponse, tool?: { name: string; arguments: object }) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish_reason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: 'assistant', content: '' });
  if (tool) {
    const call = {
      index: 0,
      id: 'call-expert',
      type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
    };
    chunk({ tool_calls: [call] });
    chunk({}, 'tool_calls');
  } else {
    chunk({ content: 'Done.' });
    chunk({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
}

async function turn(client: SwiftnestClient, prompt: string, answer: 'rejected' | 'allowed-once') {
  const { sessionId } = await client.createSession();
  const sub = await client.follow(sessionId, { signal: AbortSignal.timeout(30_000) });
  const events: SwiftnestEvent[] = [];
  const done = (async () => {
    for await (const event of sub) {
      events.push(event);
      if (event.type === 'approval-request') await client.answerApproval(event.requestId, answer);
      if (event.type === 'turn-end') break;
    }
  })();
  try {
    await client.sendMessage(sessionId, prompt);
    await done;
    return events;
  } finally {
    sub.close();
  }
}

/** The App's flow: save a catalog provider's key and model, apply, and the kernel comes back with it. */
async function switchToCloudExpert(client: SwiftnestClient, kernel: RunningKernel) {
  await client.setModelKey('deepseek', 'sk-e2e-not-a-real-key');
  const saved = await client.updateModels({ expert: { provider: 'deepseek', model: 'deepseek-v4-pro' } });
  expect(saved.pending).toBe(true);
  const before = kernel.token;
  expect(['installing', 'restarting']).toContain((await client.applyModels()).apply.state);
  await expect.poll(() => kernel.token, { timeout: 90_000 }).not.toBe(before);
  const fresh = await connectApp(kernel);
  try {
    expect(await fresh.listModels()).toMatchObject({
      expert: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      pending: false,
      apply: { state: 'idle' },
    });
  } finally {
    fresh.close();
  }
}

function connectApp(kernel: RunningKernel) {
  return connect(pairingUrl(kernel.url, kernel.token), {
    createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
  });
}

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'real kernel hands hard tasks to the expert only after the owner approves',
  async () => {
    const model = scriptedModel();
    const server = createServer((req, res) => void model.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-models-e2e-'));
    const logs: string[] = [];
    await writeFile(
      join(home, 'models.json'),
      JSON.stringify({ expert: { provider: 'local', model: 'fake' }, expertApproval: 'ask' }),
    );
    const kernel = await startStableKernel(
      loadConfig(undefined, {
        SWIFTNEST_LANG: 'en',
        SWIFTNEST_HOME: home,
        SWIFTNEST_PLUGINS: 'tool-ultra=false',
        SWIFTNEST_PORT: '0',
        SWIFTNEST_DEVICES_PORT: '0',
        SWIFTNEST_DEVICES_MDNS: 'false',
        SWIFTNEST_MODEL_ID: 'fake',
        SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      }),
      { readyTimeoutMs: 90_000, onLine: (line) => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')) },
    );
    const client = await connectApp(kernel);
    try {
      const rejected = await turn(client, 'hand-off-rejected', 'rejected');
      const ask = rejected.find((e) => e.type === 'approval-request');
      expect(ask).toMatchObject({ toolName: EXPERT_TOOL });
      expect(rejected).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'tool-result', isError: true })]),
      );
      expect(model.requests.some(fromExpert)).toBe(false);

      const first = model.requests.find((r) => r.stream)!;
      expect(first.tools?.map((tool) => tool.function.name)).toContain(EXPERT_TOOL);
      expect(JSON.stringify(first.messages)).toContain(`\`${EXPERT_TOOL}\` tool`);

      const allowed = await turn(client, 'hand-off-allowed', 'allowed-once');
      expect(allowed).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'tool-result', isError: false })]),
      );
      await expect
        .poll(() => model.requests.some((r) => r.stream && fromExpert(r)), {
          timeout: 30_000,
        })
        .toBe(true);

      await switchToCloudExpert(client, kernel);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.stack : error}\n${logs.slice(-60).join('\n')}`, {
        cause: error,
      });
    } finally {
      client.close();
      await kernel.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  180_000,
);
