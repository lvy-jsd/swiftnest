import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SwiftnestClient, type ApiWebSocket, type SwiftnestEvent } from '@swiftnest/api';
import { loadConfig } from '../../../server/src/config.js';
import { startKernel, type RunningKernel } from '../../../server/src/kernel.js';
import { pairingUrl } from '../../../server/src/pairing.js';

// Resolve the server's existing Node transport dependency; the App itself has no ws dependency.
const { WebSocket } = createRequire(new URL('../../../server/package.json', import.meta.url))('ws') as {
  WebSocket: new (url: string, options?: { headers: Readonly<Record<string, string>> }) => ApiWebSocket;
};

interface ModelRequest {
  stream?: boolean;
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}
export class MemoryHarness {
  home = '';
  kernel?: RunningKernel;
  client = new SwiftnestClient({
    createWebSocket: (url, options) => new WebSocket(url, options) as unknown as ApiWebSocket,
  });
  requests: { prompt: string; request: ModelRequest }[] = [];
  logs: string[] = [];
  autoReviews: { entries: { id: string; text: string }[]; messages: { role: string; text: string }[] }[] = [];
  autoProposal: (input: MemoryHarness['autoReviews'][number]) => unknown = () => [{ op: 'none' }];
  private rounds = new Map<string, number>();
  private model = createServer((req, res) => {
    void this.respond(req, res);
  });
  async start(reviewDelay?: number) {
    await new Promise<void>((resolve) => this.model.listen(0, '127.0.0.1', resolve));
    this.home = await mkdtemp(join(tmpdir(), 'swiftnest-memory-e2e-'));
    if (reviewDelay !== undefined) await this.installReviewDelay(reviewDelay);
    this.kernel = await startKernel(
      loadConfig(undefined, {
        SWIFTNEST_LANG: 'en',
        SWIFTNEST_HOME: this.home,
        SWIFTNEST_PLUGINS: 'tool-ultra=false',
        SWIFTNEST_DEVICES_PORT: '0',
        SWIFTNEST_DEVICES_MDNS: 'false',
        SWIFTNEST_PORT: '0',
        SWIFTNEST_APP_DIST: fileURLToPath(new URL('../../dist', import.meta.url)),
        SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(this.model.address() as AddressInfo).port}/v1`,
        SWIFTNEST_MODEL_ID: 'fake',
      }),
      { readyTimeoutMs: 90_000, onLine: (line) => this.logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')) },
    );
    await this.client.connect(pairingUrl(this.kernel.url, this.kernel.token));
  }
  private async installReviewDelay(delay: number): Promise<void> {
    // The real module accepts a test injection; production config/env expose no delay setting.
    const module = new URL('../../../server/bundle/dist/memory.js', import.meta.url).href;
    const fixture = join(this.home, 'test-memory.mjs');
    await writeFile(
      fixture,
      `import { apply as memory, inject, name } from ${JSON.stringify(module)};
export { inject, name };
export function apply(ctx) {
  return memory(ctx, {
    home: process.env.SWIFTNEST_HOME,
    auto: process.env.SWIFTNEST_MEMORY_AUTO !== 'false',
    devicesAdminUrl: process.env.SWIFTNEST_DEVICES_ADMIN_URL,
    devicesAdminToken: process.env.SWIFTNEST_DEVICES_ADMIN_TOKEN,
  }, ${delay});
}
`,
    );
    const profile = join(this.home, 'dsh/profiles/swiftnest');
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'user.patch.yml'),
      JSON.stringify([{ id: 'swiftnest-memory', disabled: true }, { insert: [{ id: 'test-memory', name: fixture }] }]),
    );
  }
  async close() {
    this.client.close();
    await this.kernel?.stop();
    await new Promise<void>((resolve) => this.model.close(() => resolve()));
    if (this.home) await rm(this.home, { recursive: true, force: true });
  }
  async turn(sessionId: string, prompt: string): Promise<SwiftnestEvent[]> {
    const sub = await this.client.follow(sessionId, { signal: AbortSignal.timeout(25_000) });
    const events: SwiftnestEvent[] = [];
    const consume = (async () => {
      let started = false;
      for await (const event of sub) {
        if (event.type === 'user-message' && event.text === prompt) started = true;
        if (!started) continue;
        events.push(event);
        if (event.type === 'turn-end') break;
      }
    })();
    try {
      await this.client.sendMessage(sessionId, prompt);
      await consume;
      return events;
    } finally {
      sub.close();
    }
  }
  private async respond(req: IncomingMessage, res: ServerResponse) {
    if (req.url === '/v1/models') {
      res.end('{"data":[{"id":"fake"}]}');
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body) as ModelRequest;
    if (!request.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'title',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Memory test' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    if (
      request.messages.some(
        (item) => item.role === 'system' && String(item.content).includes('Review new conversation messages'),
      )
    ) {
      const user = request.messages.find((item) => item.role === 'user')!;
      const content = typeof user.content === 'string' ? user.content : (user.content as { text: string }[])[0]!.text;
      const input = JSON.parse(content) as MemoryHarness['autoReviews'][number];
      this.autoReviews.push(input);
      respond(res, undefined, JSON.stringify(this.autoProposal(input)));
      return;
    }
    const prompt = [...request.messages]
      .reverse()
      .find(
        (m) =>
          m.role === 'user' &&
          [
            'warm-up',
            'remember-now',
            'recall-later',
            'new-session',
            'reject-secret',
            'forget-now',
            'recall-forgotten',
          ].includes(m.content as string),
      )?.content as string;
    const round = this.rounds.get(prompt) ?? 0;
    this.rounds.set(prompt, round + 1);
    this.requests.push({ prompt, request });
    const tool =
      round === 0 && prompt === 'remember-now'
        ? { name: 'remember', arguments: { text: 'Prefers a quiet workspace' } }
        : round === 0 && prompt === 'recall-later'
          ? { name: 'recall', arguments: { query: 'Late fact' } }
          : undefined;
    const selected =
      round === 0 && prompt === 'reject-secret'
        ? { name: 'remember', arguments: { text: 'password=do-not-store' } }
        : tool;
    const forgetting =
      round === 0 && prompt === 'forget-now'
        ? { name: 'forget', arguments: { text: 'Prefers a quiet workspace' } }
        : round === 0 && prompt === 'recall-forgotten'
          ? { name: 'recall', arguments: { query: 'Prefers a quiet workspace' } }
          : selected;
    respond(res, forgetting);
  }
}

function respond(res: ServerResponse, tool?: { name: string; arguments: object }, text = 'Done.') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish_reason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: 'assistant', content: '' });
  if (tool) {
    chunk({
      tool_calls: [
        {
          index: 0,
          id: `call-${tool.name}`,
          type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        },
      ],
    });
    chunk({}, 'tool_calls');
  } else {
    chunk({ content: text });
    chunk({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
}
