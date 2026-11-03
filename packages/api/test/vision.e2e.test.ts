/**
 * Real kernel with a local model that cannot see: a photo is declined politely until the
 * owner agrees to the free photo reading service, then it reaches the model as a description.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig, startKernel, pairingUrl, type RunningKernel } from '../../../server/src/index.js';
import { connect, type SwiftnestClient } from '@swiftnest/api';
import { png } from '../../../client/test/fixtures/png.js';

let model: Server;
let kernel: RunningKernel;
let home: string;
const chats: string[] = [];
const looked: string[] = [];

async function body(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text;
}

beforeAll(async () => {
  model = createServer(async (req, res) => {
    if (req.url === '/free/v1/chat/completions') {
      looked.push(await body(req));
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A plain grey square.' } }] }));
    }
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    chats.push(await body(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = (d: object, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'x', model: 'fake', choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`,
      );
    delta({ role: 'assistant', content: 'Noted.' });
    delta({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  home = mkdtempSync(join(tmpdir(), 'swiftnest-vision-e2e-'));
  kernel = await startKernel(
    loadConfig(undefined, {
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOME: home,
      SWIFTNEST_PLUGINS: 'tool-ultra=false',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_PORT: '0',
      SWIFTNEST_MODEL_ID: 'fake',
      SWIFTNEST_MODEL_VISION: 'false',
      SWIFTNEST_MODEL_BASE_URL: `${base}/v1`,
      SWIFTNEST_FREE_VISION_BASE_URL: `${base}/free/v1`,
    }),
    { readyTimeoutMs: 90_000 },
  );
}, 120_000);

afterAll(async () => {
  await kernel?.stop();
  await new Promise<void>((resolve) => model?.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

async function sendPhoto(client: SwiftnestClient): Promise<string> {
  const { sessionId } = await client.createSession();
  const sub = await client.follow(sessionId, { signal: AbortSignal.timeout(30_000) });
  const done = (async () => {
    for await (const event of sub) if (event.type === 'turn-end') break;
  })();
  await client.sendMessage(sessionId, 'What is in this photo?', [
    { mediaType: 'image/png', data: png(64).toString('base64'), name: 'grey.png' },
  ]);
  await done;
  sub.close();
  return chats.filter((chat) => chat.includes('What is in this photo?')).at(-1) ?? '';
}

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'asks before using the free service, then describes photos to a model that cannot see',
  async () => {
    const client = await connect(pairingUrl(kernel.url, kernel.token, kernel.channelPairing), {
      fetch: async () => {
        throw new Error('App requests must stay inside the encrypted channel');
      },
      createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
    });
    try {
      expect((await client.listModels()).vision).toEqual({ needed: true, readers: [], free: 'ask' });

      const declined = await sendPhoto(client);
      expect(declined).toContain('no photo reading service is turned on');
      expect(declined).not.toContain('image_url');
      expect(looked).toEqual([]);

      const agreed = await client.updateModels({ freeVision: 'on' });
      expect(agreed).toMatchObject({ vision: { free: 'on' }, pending: false });
      chats.length = 0;
      const described = await sendPhoto(client);
      expect(described).toContain('A plain grey square.');
      expect(described).not.toContain('image_url');
      expect(looked[0]).toContain('image_url');
      expect(looked[0]).toContain('What is in this photo?');
    } finally {
      client.close();
    }
  },
  90_000,
);
