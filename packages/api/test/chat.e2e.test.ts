/** Real phase-0 acceptance: no external model, no credentials, no fixed ports. */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, startKernel, pairingUrl, type RunningKernel } from '../../../server/src/index.js';
import { connect, type SwiftnestClient, type SwiftnestEvent } from '@swiftnest/api';

const reply = 'Hello from Swiftnest.';
describe.skipIf(process.env.SWIFTNEST_E2E !== '1').each([
  {
    name: 'default persona',
    persona: undefined,
    expected: 'You are a helpful assistant in Swiftnest, powered by the ',
  },
  {
    name: 'configured persona',
    persona: 'You are the configured Swiftnest assistant, powered by the {{model}} model.',
    expected: 'You are the configured Swiftnest assistant, powered by the ',
  },
])('API real kernel chat (e2e, $name)', ({ persona, expected }) => {
  let model: Server | undefined;
  let kernel: RunningKernel | undefined;
  let client: SwiftnestClient | undefined;
  let home: string | undefined;
  const modelRequests: { stream?: boolean; messages: { role: string; content: unknown }[] }[] = [];
  const frames: unknown[] = [];
  const logs: string[] = [];
  beforeAll(async () => {
    model = createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake' }] }));
      } else if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        const request = JSON.parse(body);
        modelRequests.push(request);
        if (!request.stream) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              id: 'fake-title',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'Test chat' }, finish_reason: 'completed' }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
          );
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk = (delta: object, finish_reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: 'fixed-reply', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        chunk({ role: 'assistant', content: '' });
        for (const content of ['Hello ', 'from ', 'Swiftnest.']) {
          chunk({ content });
          // Yield separately to exercise the live assistant stream, rather than
          // testing only a final message buffered into one HTTP write.
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        chunk({}, 'stop');
        res.end('data: [DONE]\n\n');
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', resolve));
    home = mkdtempSync(join(tmpdir(), 'swiftnest-api-e2e-'));
    kernel = await startKernel(
      loadConfig(undefined, {
        SWIFTNEST_LANG: 'en',
        SWIFTNEST_HOME: home,
        SWIFTNEST_DEVICES_PORT: '0',
        SWIFTNEST_DEVICES_MDNS: 'false',
        SWIFTNEST_PORT: '0',
        SWIFTNEST_MODEL_ID: 'fake',
        SWIFTNEST_PERSONA: persona,
        SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      }),
      {
        readyTimeoutMs: 90_000,
        onLine: (line) => {
          logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED'));
        },
      },
    );
  }, 120_000);
  afterAll(async () => {
    client?.close();
    await kernel?.stop();
    if (model) await new Promise<void>((resolve) => model!.close(() => resolve()));
    if (home) rmSync(home, { recursive: true, force: true });
  }, 15_000);

  it('pairs → creates → follows → sends hi → receives deltas, final and turn end', async () => {
    try {
      client = await connect(pairingUrl(kernel!.url, kernel!.token), {
        fetch,
        createWebSocket: (url, { headers }) => {
          const socket = new WebSocket(url, { headers });
          socket.on('message', (data) => {
            const value = JSON.parse(String(data)).value;
            if (
              value &&
              (value.type === 'snapshot' ||
                value.type === 'assistant-stream' ||
                (value.type === 'event' &&
                  ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(
                    value.event.type,
                  )))
            )
              frames.push(value);
          });
          return socket;
        },
      });
      expect(await client.health()).toMatchObject({ ok: true, dsh: '0.2.1-rc.5', model: { reachable: true } });
      const session = await client.createSession();
      expect((await client.listSessions()).some((s) => s.sessionId === session.sessionId)).toBe(true);
      const subscription = await client.follow(session.sessionId, { signal: AbortSignal.timeout(20_000) });
      const received: SwiftnestEvent[] = [];
      const completed = (async () => {
        for await (const event of subscription) {
          received.push(event);
          if (event.type === 'turn-end') break;
        }
      })();
      expect(await client.sendMessage(session.sessionId, 'hi')).toMatchObject({ accepted: true });
      await completed;
      expect(received.filter((e) => e.type === 'error')).toEqual([]);
      expect(received.find((e) => e.type === 'user-message')).toMatchObject({ text: 'hi' });
      expect(
        received
          .filter((e) => e.type === 'assistant-delta')
          .map((e) => e.text)
          .join(''),
      ).toBe(reply);
      expect(received.find((e) => e.type === 'assistant-message')).toMatchObject({ text: reply });
      expect(received.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
      expect(modelRequests.some((r) => JSON.stringify(r).includes('hi'))).toBe(true);
      // DSH's title generator streams too, but gets an aggregated transcript
      // rather than the agent's original user message and persona.
      const chatRequests = modelRequests.filter((request) =>
        request.messages.some((message) => message.role === 'user' && message.content === 'hi'),
      );
      expect(chatRequests.length).toBeGreaterThan(0);
      for (const request of chatRequests) {
        const system = request.messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n');
        expect(system).toContain(expected);
        expect(system).not.toContain('coding agent');
        expect(system).not.toContain('{{model}}');
      }
      if (process.env.SWIFTNEST_RECORD_FIXTURES === '1') {
        writeFileSync(new URL('./fixtures/chat.json', import.meta.url), `${JSON.stringify(frames, null, 2)}\n`);
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.stack : error}\nKernel diagnostics:\n${logs.slice(-50).join('\n')}`,
      );
    }
  });
});
