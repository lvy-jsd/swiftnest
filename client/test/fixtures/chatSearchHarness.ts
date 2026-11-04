import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SwiftnestClient, type ApiWebSocket, type SwiftnestEvent } from '@swiftnest/api';
import { loadConfig } from '../../../server/src/config.js';
import { startKernel, type RunningKernel } from '../../../server/src/kernel.js';
import { pairingUrl } from '../../../server/src/pairing.js';

const { WebSocket } = createRequire(new URL('../../../server/package.json', import.meta.url))('ws');
export const OLD_CHAT_TEXT = '上次杭州旅行，我们选择了自行车穿过果园。 The orchard bicycle route was peaceful.';
export class ChatSearchHarness {
  home = '';
  kernel?: RunningKernel;
  client = createClient();
  logs: string[] = [];
  embeddings: { input: string[]; model: string }[] = [];
  private model = createServer((req, res) => {
    void this.respond(req, res);
  });
  async start() {
    await new Promise<void>((resolve) => this.model.listen(0, '127.0.0.1', resolve));
    this.home = await mkdtemp(join(tmpdir(), 'swiftnest-search-e2e-'));
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
      {
        readyTimeoutMs: 90_000,
        onLine: (line) => this.logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')),
      },
    );
    await this.reconnect();
  }
  async reconnect() {
    this.client.close();
    this.client = createClient();
    await this.client.connect(pairingUrl(this.kernel!.url, this.kernel!.token, this.kernel!.channelPairing));
  }
  async close() {
    this.client.close();
    await this.kernel?.stop();
    this.model.closeAllConnections();
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
      res.end('{"data":[{"id":"fake"},{"id":"fake-embed"}]}');
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = body ? JSON.parse(body) : {};
    if (req.url === '/v1/embeddings') {
      this.embeddings.push(request);
      res.end(
        JSON.stringify({
          data: request.input.map((text: string, index: number) => ({
            index,
            embedding: /bicycle|orchard|commuting|自行车|果园/.test(text) ? [1, 0] : [0, 1],
          })),
        }),
      );
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const last = request.messages?.at(-1);
    const prompt =
      last?.role !== 'tool'
        ? ([...(request.messages ?? [])]
            .reverse()
            .find(
              (message) =>
                message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('lookup:'),
            )?.content ?? '')
        : '';
    const tool =
      request.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'search_chats') &&
      prompt.startsWith('lookup:')
        ? { name: 'search_chats', arguments: { query: prompt.slice('lookup:'.length), limit: 5 } }
        : undefined;
    if (!request.stream) {
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'Travel notes' }, finish_reason: 'stop' }],
        }),
      );
      return;
    }
    stream(res, tool);
  }
}
function stream(res: ServerResponse, tool?: { name: string; arguments: object }) {
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
          id: 'call-search',
          type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        },
      ],
    });
    chunk({}, 'tool_calls');
  } else {
    chunk({ content: 'Travel notes' });
    chunk({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
}

function createClient() {
  return new SwiftnestClient({ createWebSocket: (url, options) => new WebSocket(url, options) as ApiWebSocket });
}
