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
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += String(chunk);
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
  return { requests, handle };
}

async function sendPhoto(page: Page, file: string) {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(file);
  const drafts = page.getByRole('list', { name: en('photoDrafts') });
  await drafts.locator('img').waitFor();
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

it.skipIf(process.env.SWIFTNEST_E2E !== '1' || process.env.SWIFTNEST_WEB_E2E !== '1')(
  'a beginner sends a large photo from the composer and sees it in the chat',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-photos-real-'));
    const model = visionModel();
    const server = createServer((req, res) => void model.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
        SWIFTNEST_MODEL_VISION: 'true',
        SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      }),
      { readyTimeoutMs: 30_000 },
    );
    try {
      const file = join(home, 'big.png');
      await writeFile(file, png(3000, 2000));
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      await page.goto(webAppUrl(kernel.url, kernel.token));
      const photo = await sendPhoto(page, file);
      expect(Number(await photo.getAttribute('width'))).toBeLessThanOrEqual(2048);
      const dir = process.env.SWIFTNEST_SCREENSHOTS;
      if (dir) await page.screenshot({ path: join(dir, 'photos-chat.png') });
      expect(model.requests.some((body) => body.includes('What is in this photo?') && body.includes('image_url'))).toBe(
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await kernel.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  90_000,
);
