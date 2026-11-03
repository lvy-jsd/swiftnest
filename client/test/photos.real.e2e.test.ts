/**
 * Real App + real DSH kernel with a vision model: a beginner adds a large photo, sees the
 * preview, sends it, and the photo shows in the chat while the model receives it shrunk.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';
import { startKernel } from '../../server/src/kernel';
import { webAppUrl } from '../../server/src/pairing';
import { png } from './fixtures/png';
import { translate } from '../src/i18n';
import { launchChromium } from './browser';

const en = (key: Parameters<typeof translate>[1]) => translate('en', key);

function visionModel() {
  const requests: string[] = [];
  const looked: string[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    if (req.url === '/free/v1/chat/completions') {
      looked.push(body);
      const answer = { choices: [{ message: { role: 'assistant', content: 'A plain grey rectangle.' } }] };
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    }
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = (d: object, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'x', model: 'fake', choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`,
      );
    delta({ role: 'assistant', content: 'A grey square.' });
    delta({}, 'stop');
    res.end('data: [DONE]\n\n');
  };
  return { requests, looked, handle };
}

async function addPhoto(page: Page, file: string) {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(file);
  await page
    .getByRole('list', { name: en('photoDrafts') })
    .locator('img')
    .waitFor();
}

async function sendPhoto(page: Page) {
  const drafts = page.getByRole('list', { name: en('photoDrafts') });
  await page.getByRole('textbox', { name: 'Write a message' }).fill('What is in this photo?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => drafts.count()).toBe(0);
  const messages = page.getByRole('list', { name: 'Messages' });
  await messages.getByText('A grey square.', { exact: true }).waitFor();
  const photo = messages.locator('img.message-photo');
  await expect
    .poll(async () => (await photo.getAttribute('src')) ?? '')
    .toMatch(/^data:image\/(jpeg|png|webp);base64,/);
  return photo;
}

const runs = process.env.SWIFTNEST_E2E === '1' && process.env.SWIFTNEST_WEB_E2E === '1';

/** A real kernel and App in a phone-sized browser; `vision` says whether the local model sees. */
async function withApp(
  vision: boolean,
  test: (page: Page, model: ReturnType<typeof visionModel>, home: string) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-photos-real-'));
  const model = visionModel();
  const server = createServer((req, res) => void model.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await launchChromium();
  const kernel = await startKernel(
    loadConfig(undefined, {
      SWIFTNEST_HOME: home,
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOST: '127.0.0.1',
      SWIFTNEST_PORT: '0',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_PLUGINS: 'tool-ultra=false',
      SWIFTNEST_APP_DIST: fileURLToPath(new URL('../dist/', import.meta.url)),
      SWIFTNEST_MODEL_ID: 'fake',
      SWIFTNEST_MODEL_VISION: String(vision),
      SWIFTNEST_MODEL_BASE_URL: `${base}/v1`,
      SWIFTNEST_FREE_VISION_BASE_URL: `${base}/free/v1`,
    }),
    { readyTimeoutMs: 30_000 },
  );
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
    await page.goto(webAppUrl(kernel.url, kernel.token));
    await test(page, model, home);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await kernel.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}

it.skipIf(!runs)(
  'a beginner sends a large photo from the composer and sees it in the chat',
  () =>
    withApp(true, async (page, model, home) => {
      const file = join(home, 'big.png');
      await writeFile(file, png(3000, 2000));
      await addPhoto(page, file);
      const photo = await sendPhoto(page);
      expect(Number(await photo.getAttribute('width'))).toBeLessThanOrEqual(2048);
      const dir = process.env.SWIFTNEST_SCREENSHOTS;
      if (dir) await page.screenshot({ path: join(dir, 'photos-chat.png') });
      expect(model.requests.some((body) => body.includes('What is in this photo?') && body.includes('image_url'))).toBe(
        true,
      );
    }),
  90_000,
);

it.skipIf(!runs)(
  'with a local model that cannot see, the owner is asked once, and an allowed photo reaches it as a description',
  () =>
    withApp(false, async (page, model, home) => {
      const file = join(home, 'photo.png');
      await writeFile(file, png(800, 600));
      await addPhoto(page, file);
      const consent = page.getByRole('group', { name: en('photoConsentTitle') });
      await consent.waitFor();
      const dir = process.env.SWIFTNEST_SCREENSHOTS;
      if (dir) await page.screenshot({ path: join(dir, 'photos-consent.png') });
      await consent.getByRole('button', { name: en('photoConsentAgree') }).click();
      await expect.poll(() => consent.count()).toBe(0);
      await sendPhoto(page);
      expect(model.looked.some((body) => body.includes('image_url'))).toBe(true);
      const chats = model.requests.filter((body) => body.includes('What is in this photo?'));
      expect(chats.some((body) => body.includes('A plain grey rectangle.'))).toBe(true);
      expect(chats.some((body) => body.includes('image_url'))).toBe(false);
    }),
  90_000,
);
