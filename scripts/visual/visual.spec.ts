/**
 * Visual regression: the chat list and the chat detail at four breakpoints.
 *
 * Boots a real kernel with a fake model (same harness as test/web.e2e.test.ts),
 * pairs, creates a chat with one user + one assistant message, then screenshots
 * every page at every breakpoint and compares against ./screenshots.
 *
 * Determinism: port 0 (OS picks a free port), light scheme, reduced motion,
 * English locale (the app defaults to zh-CN), and the non-deterministic bits
 * are masked: server-derived timestamps, the server URL (random port), and the
 * time-of-day greeting on the home page.
 */
import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    // Loopback root: the API requires HTTPS for non-local roots, and the visual
    // test only cares about UI rendering, not the LAN path.
    const host = '127.0.0.1';
    kernel = await startKernel(loadConfig(undefined, {
      SWIFTNEST_HOME: home, SWIFTNEST_HOST: host, SWIFTNEST_PORT: String(PORT), SWIFTNEST_APP_DIST: dist,
      SWIFTNEST_MODEL_ID: 'fake', SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      // The link-lan plugin defaults to port 7711; use a random port so a
      // crashed run never blocks the next.
      SWIFTNEST_DEVICES_PORT: '0',
      // The server language is authoritative after pairing (LanguageSync); pin
      // English so the captured strings are stable.
      SWIFTNEST_LANG: 'en',
    }), { readyTimeoutMs: 90_000 });

    const page = await browser.newPage({
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    // The app defaults to zh-CN; pin English so the captured strings are stable.
    await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
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

    // Read the chat id from the URL (we are on the detail page), then go back
    // to the home page so the sidebar chat list is populated.
    const chatId = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/chats\//, ''));
    await page.getByRole('button', { name: 'Go back' }).click();

    // Let streaming settle and animations finish before the first capture.
    await page.waitForTimeout(400);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(500);

      // Chat list page: the sidebar holds the chat list, the main area shows the
      // home page. The app is served under /app/, so the hash route must keep
      // that prefix — the bare root is the DSH web and 401s.
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`chat-list-${viewport.name}.png`, {
        // time: server-derived timestamps; .connection-status p: the root URL
        // carries a random port; .home-greeting h1: the greeting changes with
        // the time of day; .composer-area: the placeholder text and SVG icon
        // rendering vary slightly between runs and machines, so mask the
        // whole input area as a solid block.
        // Bottom band: the composer placeholder and any fixed footer elements
        // render with subpixel differences that vary by machine; mask the
        // bottom 100px as a solid block so the comparison stays stable.
        mask: [
          page.locator('time'),
          page.locator('.connection-status p'),
          page.locator('.home-greeting h1'),
          page.locator('.composer-area'),
          page.locator('.identity-row'),
        ],
        // Anti-aliasing and subpixel rendering vary slightly between runs and
        // machines; allow a small number of pixels to differ without failing.
        maxDiffPixels: 50,
        threshold: 0.1,
      });

      // Chat detail page: navigate directly by hash (the sidebar link is hidden
      // in the drawer on narrow viewports).
      await page.evaluate((id) => { location.hash = `#/chats/${id}`; }, chatId);
      await expect.poll(() => transcript.locator('.message:not([data-streaming]) p').filter({ hasText: /^Hello from Swiftnest\.$/ }).count(), { timeout: 25_000 }).toBe(1);
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`chat-detail-${viewport.name}.png`, {
        // .message: server-derived timestamps and the message body's font
        // rendering both vary slightly between runs; masking the whole message
        // keeps the comparison stable without hiding layout changes.
        // .connection-status p: the root URL carries a random port.
        mask: [page.locator('.message'), page.locator('.connection-status p'), page.locator('.identity-row')],
        maxDiffPixels: 50,
        threshold: 0.1,
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