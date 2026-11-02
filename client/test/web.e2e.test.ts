/** Build first. Opt-in; no downloads and no external model credentials. */
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';
import { startKernel } from '../../server/src/kernel';
import type { RunningKernel } from '../../server/src/kernel';
import { webAppUrl } from '../../server/src/pairing';

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')('web App: pair → new chat → stream → queue → reply → reopen', async context => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.SWIFTNEST_CHROMIUM ? { executablePath: process.env.SWIFTNEST_CHROMIUM } : {}), args: ['--no-sandbox', '--no-proxy-server'] });
  } catch { context.skip(true, 'Chromium unavailable; install a Playwright browser or set SWIFTNEST_CHROMIUM.'); return; }
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  let home: string | undefined;
  let kernel: RunningKernel | undefined;
  const logs: string[] = [];
  const diagnostics: string[] = [];
  let page: import('@playwright/test').Page | undefined;
  const requests: string[] = [];
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"fake"}]}'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body); requests.push(body);
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'title', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Browser chat' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    for (const content of ['Hello ', 'from ', 'Swiftnest.']) {
      chunk({ content }); await new Promise(resolve => setTimeout(resolve, 350));
    }
    chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  try {
    expect(existsSync(join(dist, 'index.html')), 'Run pnpm --filter @swiftnest/app build:web first').toBe(true);
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    home = await mkdtemp(join(tmpdir(), 'swiftnest-web-e2e-'));
    // A real non-loopback address exercises the insecure-context LAN path.
    const host = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address ?? '127.0.0.1';
    kernel = await startKernel(loadConfig(undefined, {
      SWIFTNEST_HOME: home, SWIFTNEST_HOST: host, SWIFTNEST_PORT: '0', SWIFTNEST_APP_DIST: dist,
      SWIFTNEST_MODEL_ID: 'fake', SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    }), { readyTimeoutMs: 90_000, onLine: line => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')) });
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1100, height: 800 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    page.on('pageerror', error => diagnostics.push(error.message));
    page.on('response', response => { if (response.status() >= 400) diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const modes: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/session/prompt')) modes.push(request.postDataJSON().payload.args.request.mode); });
    await page.goto(new URL('app/chats/deep-link', kernel.url).href);
    await page.getByRole('link', { name: 'Pair server', exact: true }).waitFor();
    await page.goto(webAppUrl(kernel.url, kernel.token));
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    expect(page.url()).not.toContain('token');
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['swiftnest.serverRoot']);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Write a message' });
    await composer.fill('hi');
    await page.getByRole('button', { name: 'Send message' }).click();
    const transcript = page.getByRole('list', { name: 'Messages' });
    await transcript.locator('[data-streaming="true"]').filter({ hasText: 'Hello' }).waitFor();
    await composer.fill('queued');
    expect(await composer.isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => transcript.locator('.message:not([data-streaming]) p').filter({ hasText: /^Hello from Swiftnest\.$/ }).count(), { timeout: 25_000 }).toBe(2);
    expect(modes).toEqual(['queue', 'queue']);
    expect(requests.some(body => body.includes('queued'))).toBe(true);
    expect(await transcript.locator('[data-streaming="true"]').count()).toBe(0);
    if (process.env.SWIFTNEST_WEB_SCREENSHOT) await page.screenshot({ path: process.env.SWIFTNEST_WEB_SCREENSHOT });
    await page.getByRole('button', { name: 'Go back' }).click();
    await page.getByRole('main').locator('a[href^="#/chats/"]').first().click();
    await expect.poll(() => transcript.locator('p').filter({ hasText: /^Hello from Swiftnest\.$/ }).count()).toBe(2);
    expect(errors).toEqual([]);
    // A phone viewport and a keyboard-sized resize keep the composer visible.
    for (const height of [844, 440]) {
      await page.setViewportSize({ width: 390, height });
      await composer.focus();
      const rect = await composer.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    }
    await page.getByRole('button', { name: 'Go back' }).click();
    await page.getByRole('button', { name: 'Open preferences' }).click();
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.close();
  } catch (error) {
    const body = await page?.locator('body').innerText().catch(() => 'No page');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics.join('\n')}\n${body}\n${logs.slice(-30).join('\n')}`.replace(/token(?:=|%3D)[^&\s]+/gi, 'token=REDACTED'));
  } finally {
    await browser.close(); await kernel?.stop();
    await new Promise<void>(resolve => model.close(() => resolve()));
    if (home) await rm(home, { recursive: true, force: true });
  }
}, 120_000);
