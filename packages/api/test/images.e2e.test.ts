/** Real kernel, through the encrypted App channel: a photo sent with a message reaches a vision model and can be read back. */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig, startKernel, pairingUrl, type RunningKernel } from '../../../server/src/index.js';
import { connect, type SwiftnestEvent } from '@swiftnest/api';
import { png } from '../../../client/test/fixtures/png.js';

let model: Server;
let kernel: RunningKernel;
let home: string;
const requests: unknown[] = [];

beforeAll(async () => {
  model = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += String(chunk);
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = (d: object, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'x', model: 'fake', choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`,
      );
    delta({ role: 'assistant', content: 'Seen.' });
    delta({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  home = mkdtempSync(join(tmpdir(), 'swiftnest-images-e2e-'));
  kernel = await startKernel(
    loadConfig(undefined, {
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOME: home,
      SWIFTNEST_PLUGINS: 'tool-ultra=false',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_PORT: '0',
      SWIFTNEST_MODEL_ID: 'fake',
      SWIFTNEST_MODEL_VISION: 'true',
      SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    }),
    { readyTimeoutMs: 90_000 },
  );
}, 120_000);

afterAll(async () => {
  await kernel?.stop();
  await new Promise<void>((resolve) => model?.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'stores a photo sent with a message and reads it back',
  async () => {
    const client = await connect(pairingUrl(kernel.url, kernel.token, kernel.channelPairing), {
      fetch: async () => {
        throw new Error('App requests must stay inside the encrypted channel');
      },
      createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
    });
    try {
      const { sessionId } = await client.createSession();
      const sub = await client.follow(sessionId, { signal: AbortSignal.timeout(30_000) });
      const events: SwiftnestEvent[] = [];
      const done = (async () => {
        for await (const event of sub) {
          events.push(event);
          if (event.type === 'turn-end') break;
        }
      })();
      const photo = png(64).toString('base64');
      await client.sendMessage(sessionId, 'What is this?', [{ mediaType: 'image/png', data: photo, name: 'grey.png' }]);
      await done;
      sub.close();
      const sent = events.find((e) => e.type === 'user-message');
      expect(sent).toMatchObject({ text: 'What is this?', images: [{ width: 64, height: 64, name: 'grey.png' }] });
      const image = sent?.type === 'user-message' ? sent.images![0]! : undefined;
      // DSH stores a normalized copy; the App gets it back as an image it can show.
      expect(await client.readImage(sessionId, image!)).toMatch(new RegExp(`^data:${image!.mediaType};base64,.{40}`));
      expect(JSON.stringify(requests.at(-1))).toContain('image_url');
    } finally {
      client.close();
    }
  },
  60_000,
);
