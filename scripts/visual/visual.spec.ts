/**
 * Visual regression: the chat list and the chat detail at four breakpoints.
 *
 * Boots a real kernel with a fake model (same harness as test/web.e2e.test.ts),
 * pairs, creates a chat with one user + one assistant message, then screenshots
 * every page at every breakpoint and compares against ./screenshots.
 *
 * Determinism: port 0 (OS picks a free port), light scheme, reduced motion,
 * en-US locale, and the server-derived timestamp in the chat list is masked
 * (it changes every run).
 */
import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/src/config';
import { startKernel } from '../../server/src/kernel';
import type { RunningKernel } from '../../server/src/kernel';
import { webAppUrl } from '../../server/src/pairing';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = join(root, 'client/dist');
// Port 0 lets the OS pick a free port, so a crashed run never blocks the next.
const PORT = Number(process.env.SWIFTNEST_VISUAL_PORT ?? 0);

/** Design §breakpoints: phone <600, tablet 600–1024, desktop 1024–1440, wide >1440. */
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'wide', width: 1600, height: 900 },
] as const;

test('chat list + chat detail at four breakpoints', async () => {
  expect(existsSync(join(dist, 'index.html')), 'Run pnpm --filter @swiftnest/app build:web first').toBe(true);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"fake"}]}'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body);
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'title', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Browser chat' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    for (const content of ['Hello ', 'from ', 'Swiftnest.']) {
      chunk({ content }); await new Promise(resolve => setTimeout(resolve, 120));
    }
    chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  let home: string | undefined;
  let kernel: RunningKernel | undefined;
  try {
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    home = await mkdtemp(join(tmpdir(), 'swiftnest-visual-'));
    // A real non-loopback address exercises the same LAN path as the e2e test.
    const host = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address ?? '127.0.0.1';
    kernel = await startKernel(loadConfig(undefined, {
      SWIFTNEST_HOME: home, SWIFTNEST_HOST: host, SWIFTNEST_PORT: String(PORT), SWIFTNEST_APP_DIST: dist,
      SWIFTNEST_MODEL_ID: 'fake', SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    }), { readyTimeoutMs: 90_000 });

    const page = await browser.newPage({
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    await page.goto(new URL('app/chats/deep-link', kernel.url).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('link', { name: 'Pair server', exact: true }).waitFor({ timeout: 30_000 });
    await page.goto(webAppUrl(kernel.url, kernel.token), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor({ timeout: 30_000 });

    // One chat with a finished exchange, so both pages have stable content.
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Write a message' });
    await composer.fill('hi');
    await page.getByRole('button', { name: 'Send message' }).click();
    const transcript = page.getByRole('list', { name: 'Messages' });
    await expect.poll(() => transcript.locator('.message:not([data-streaming]) p').filter({ hasText: /^Hello from Swiftnest\.$/ }).count(), { timeout: 25_000 }).toBe(1);

    // Go back to the chat list so it is populated, then read the chat id.
    await page.getByRole('button', { name: 'Go back' }).click();
    const listLink = page.getByRole('main').locator('a[href^="#/chats/"]').first();
    await listLink.waitFor({ timeout: 20_000 });
    const chatId = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/chats\//, ''));

    // Let streaming settle and animations finish before the first capture.
    await page.waitForTimeout(400);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(500);

      // Chat list page. The app is served under /app/, so the hash route must
      // keep that prefix — the bare root is the DSH web and 401s.
      await page.evaluate(() => { location.hash = '#/'; });
      await page.getByRole('main').locator('a[href^="#/chats/"]').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`chat-list-${viewport.name}.png`, {
        // time: server-derived timestamp; .connection-status p: the root URL
        // carries a random port, so it changes every run.
        mask: [page.locator('time'), page.locator('.connection-status p')],
      });

      // Chat detail page: go back to the list, then click into the chat.
      await page.evaluate(() => { location.hash = '#/'; });
      await page.getByRole('main').locator('a[href^="#/chats/"]').first().waitFor({ timeout: 20_000 });
      await page.getByRole('main').locator('a[href^="#/chats/"]').first().click();
      await expect.poll(() => transcript.locator('.message:not([data-streaming]) p').filter({ hasText: /^Hello from Swiftnest\.$/ }).count(), { timeout: 25_000 }).toBe(1);
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`chat-detail-${viewport.name}.png`, {
        // .page-header__titles p: the subtitle shows the root URL (random port).
        mask: [page.locator('time'), page.locator('.connection-status p'), page.locator('.page-header__titles p')],
      });
    }
    await page.close();
  } finally {
    await browser.close();
    await kernel?.stop();
    await new Promise<void>(resolve => model.close(() => resolve()));
    if (home) await rm(home, { recursive: true, force: true });
  }
});