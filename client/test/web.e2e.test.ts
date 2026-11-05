import { openNavigation, openPreferences } from './navigation';
import { testTls } from './fixtures/tls';
/** Build first. Opt-in; no downloads and no external model credentials. */
import { launchChromium } from './browser';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';
import { startKernel } from '../../server/src/kernel';
import type { RunningKernel } from '../../server/src/kernel';
import { Perch } from '@swiftnest/core';
import { runLanPerch } from '@swiftnest/link-lan';
import files from '@swiftnest/cap-files';
import { webAppUrl } from '../../server/src/pairing';

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'web App: pair → new chat → stream → queue → reply → reopen',
  async () => {
    const browser = await launchChromium();
    const dist = fileURLToPath(new URL('../dist/', import.meta.url));
    let home: string | undefined;
    let kernel: RunningKernel | undefined;
    let perch: Perch | undefined;
    let perchRun: ReturnType<typeof runLanPerch> | undefined;
    const logs: string[] = [];
    const diagnostics: string[] = [];
    let page: import('@playwright/test').Page | undefined;
    const requests: string[] = [];
    const model = createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"fake"}]}');
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const request = JSON.parse(body);
      requests.push(body);
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'title',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Browser chat' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta: object, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      chunk({ role: 'assistant', content: '' });
      for (const content of ['Hello ', 'from ', 'Swiftnest.']) {
        chunk({ content });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      chunk({}, 'stop');
      res.end('data: [DONE]\n\n');
    });
    try {
      expect(existsSync(join(dist, 'index.html')), 'Run pnpm --filter @swiftnest/app build:web first').toBe(true);
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      home = await mkdtemp(join(tmpdir(), 'swiftnest-web-e2e-'));
      // A real non-loopback address exercises the browser Noise channel over HTTPS.
      const host =
        Object.values(networkInterfaces())
          .flat()
          .find((address) => address?.family === 'IPv4' && !address.internal)?.address ?? '127.0.0.1';
      const config = loadConfig(undefined, {
        SWIFTNEST_LANG: 'en',
        SWIFTNEST_HOME: home,
        SWIFTNEST_DEVICES_PORT: '0',
        SWIFTNEST_DEVICES_MDNS: 'false',
        SWIFTNEST_HOST: host,
        SWIFTNEST_PORT: '0',
        SWIFTNEST_APP_DIST: dist,
        SWIFTNEST_MODEL_ID: 'fake',
        SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      });
      kernel = await startKernel(config, {
        env: await testTls(config, host),
        readyTimeoutMs: 90_000,
        onLine: (line) => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')),
      });
      page = await browser.newPage({
        locale: 'en-US',
        viewport: { width: 1100, height: 800 },
        ignoreHTTPSErrors: true,
      });
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('pageerror', (error) => diagnostics.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 400) diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`);
      });
      const modes: string[] = [];
      const wireFrames: Buffer[] = [];
      page.on('websocket', (socket) => {
        socket.on('framesent', ({ payload }) => wireFrames.push(Buffer.from(payload)));
        socket.on('framereceived', ({ payload }) => wireFrames.push(Buffer.from(payload)));
      });
      page.on('request', (request) => {
        if (request.url().endsWith('/swiftnest/api/chat')) modes.push(request.postDataJSON().request.mode);
      });
      await page.goto(new URL('app/chats/deep-link', kernel.url).href);
      await page.getByRole('link', { name: 'Pair server', exact: true }).waitFor();
      await page.goto(webAppUrl(kernel.url, kernel.token, kernel.channelPairing));
      await expect.poll(() => page!.getByRole('button', { name: 'New chat', exact: true }).isEnabled()).toBe(true);
      expect(await page.locator('.sidebar .identity-row [role="status"]').innerText()).toBe('Connected · Encrypted');
      expect(page.url()).not.toContain('token');
      expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual([
        'swiftnest.channelPins',
        'swiftnest.locale',
        'swiftnest.serverRoot',
      ]);
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      expect(page.url()).not.toContain('#/chats/');
      const composer = page.getByRole('textbox', { name: 'Write a message' });
      await composer.fill('hi');
      await page.getByRole('button', { name: 'Send message' }).click();
      const transcript = page.getByRole('list', { name: 'Messages' });
      await transcript.locator('[data-streaming="true"]').filter({ hasText: 'Hello' }).waitFor();
      await composer.fill('queued');
      expect(await composer.isEnabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect
        .poll(
          () =>
            transcript
              .locator('.message:not([data-streaming]) p')
              .filter({ hasText: /^Hello from Swiftnest\.$/ })
              .count(),
          { timeout: 25_000 },
        )
        .toBe(2);
      expect(modes).toEqual([]);
      expect(wireFrames.length).toBeGreaterThan(3);
      expect(Buffer.concat(wireFrames).includes(Buffer.from('Hello from Swiftnest.'))).toBe(false);
      expect(Buffer.concat(wireFrames).includes(Buffer.from('queued'))).toBe(false);
      expect(Buffer.concat(wireFrames).includes(Buffer.from(kernel.token))).toBe(false);
      expect(requests.some((body) => body.includes('queued'))).toBe(true);
      expect(await transcript.locator('[data-streaming="true"]').count()).toBe(0);
      if (process.env.SWIFTNEST_WEB_SCREENSHOT) await page.screenshot({ path: process.env.SWIFTNEST_WEB_SCREENSHOT });
      await page.getByRole('button', { name: 'Go back' }).click();
      await (await openNavigation(page)).locator('a[href^="#/chats/"]').first().click();
      await expect
        .poll(() =>
          transcript
            .locator('p')
            .filter({ hasText: /^Hello from Swiftnest\.$/ })
            .count(),
        )
        .toBe(2);
      // Device management and owner approvals through the real same-origin proxy, at phone width.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Go back' }).click();
      await (await openNavigation(page)).getByRole('link', { name: /^Devices/ }).click();
      await page.getByRole('button', { name: 'Pair a device', exact: true }).click();
      const pairingCard = page.getByRole('article', { name: 'Pair a device' });
      await pairingCard.locator('output').waitFor();
      const code = (await pairingCard.locator('output').innerText()).trim();
      const address = (await pairingCard.locator('code').first().innerText()).trim();
      const shared = join(home!, 'shared');
      await mkdir(shared);
      perch = await new Perch({ device: 'browser-device' }).use(files, { roots: [shared] });
      perchRun = runLanPerch(perch, { url: address, reconnect: false, pairing: { code, confirm: async () => true } });
      await page.getByText(perch.identity.fingerprint, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Matches, allow' }).click();
      await page.getByRole('heading', { name: 'browser-device', exact: true }).waitFor();
      await page.locator('.device-tile').getByText('Online', { exact: true }).waitFor();
      await page.locator('.device-tile summary').click();
      expect(await page.getByRole('list', { name: 'Devices', exact: true }).innerText()).toContain('files');
      const args = { path: join(shared, 'approved.txt'), content: 'Approved from phone-width App' };
      const write = await kernel.devices.nest.call('browser-device__files__write', args, {
        id: 'browser-test',
        name: 'Browser requester',
      });
      const approvalList = page.getByRole('list', { name: 'Waiting for approval', exact: true });
      await approvalList.getByText('Browser requester', { exact: false }).waitFor();
      expect(await approvalList.innerText()).toContain(args.content);
      await approvalList.getByRole('button', { name: 'Review request', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Review request' })
        .getByRole('button', { name: 'Approve', exact: true })
        .click();
      await expect.poll(() => kernel!.devices.nest.tasks.get(write.id)?.state).toBe('succeeded');
      expect(await readFile(args.path, 'utf8')).toBe(args.content);
      await page.getByRole('dialog', { name: 'Review request' }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Go back' }).click();
      await (await openNavigation(page)).locator('a[href^="#/chats/"]').first().click();
      const denied = await kernel.devices.nest.call(
        'browser-device__files__write',
        { ...args, content: 'Do not write' },
        { id: 'browser-test' },
      );
      await page.getByRole('button', { name: 'Waiting for approval · 1', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Review request' })
        .getByRole('button', { name: 'Deny', exact: true })
        .click();
      await expect.poll(() => kernel!.devices.nest.tasks.get(denied.id)?.state).toBe('denied');
      expect(await readFile(args.path, 'utf8')).toBe(args.content);
      await page.getByRole('dialog', { name: 'Review request' }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Go back' }).click();
      await (await openNavigation(page)).getByRole('link', { name: /^Devices/ }).click();
      await page.getByRole('button', { name: 'Revoke device', exact: true }).click();
      const revoke = page.getByRole('dialog', { name: 'Revoke device' });
      await revoke.waitFor();
      expect(kernel.devices.nest.devicesStore.list()).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await revoke.getByRole('button', { name: 'Revoke device', exact: true }).click();
      await page.getByText('No paired devices yet.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Go back' }).click();
      // Cross-device language sync, explicit English system locale, and persistence.
      await openPreferences(page);
      const relayForm = page
        .locator('details')
        .filter({ has: page.getByText('Advanced: access away from home', { exact: true }) });
      expect(await relayForm.getAttribute('open')).toBeNull();
      await relayForm.locator('summary').click();
      await relayForm.getByLabel('Relay address', { exact: true }).fill('http://127.0.0.1:1/');
      const relaySecret = 'r'.repeat(32);
      await relayForm.getByLabel('Relay secret', { exact: true }).fill(relaySecret);
      await relayForm.getByRole('button', { name: 'Save', exact: true }).click();
      await relayForm.getByText('Saved.', { exact: false }).waitFor();
      expect(await relayForm.getByLabel('Relay secret', { exact: true }).inputValue()).toBe('');
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(relaySecret);
      await relayForm.getByRole('button', { name: 'Turn off remote access', exact: true }).click();
      await expect.poll(() => relayForm.getByLabel('Relay address', { exact: true }).inputValue()).toBe('');
      await relayForm.locator('summary').click();
      await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '帮我安排一天的计划', exact: true }).waitFor();
      const second = await browser.newPage({
        locale: 'en-US',
        viewport: { width: 390, height: 844 },
        ignoreHTTPSErrors: true,
      });
      await second.goto(new URL('app/', kernel.url).href);
      await second.getByRole('link', { name: '配对服务器', exact: true }).waitFor();
      // Save an offline English choice and reload it, before choosing Chinese for pairing.
      await openPreferences(second, 'zh-CN');
      await second.getByLabel('语言', { exact: true }).selectOption('en');
      await second.reload();
      await second.getByRole('link', { name: 'Pair server', exact: true }).waitFor();
      await openPreferences(second);
      await second.getByLabel('Language', { exact: true }).selectOption('zh-CN');
      await second.getByRole('button', { name: '完成', exact: true }).click();
      await second.goto(webAppUrl(kernel.url, kernel.token, kernel.channelPairing));
      await second.getByRole('button', { name: '帮我安排一天的计划', exact: true }).waitFor();
      await openPreferences(second, 'zh-CN');
      await second.getByLabel('语言', { exact: true }).selectOption('en');
      await page.getByRole('button', { name: 'Help me plan my day', exact: true }).waitFor();
      await second.reload();
      await second.getByRole('button', { name: 'Help me plan my day', exact: true }).waitFor();
      expect(await second.locator('html').getAttribute('lang')).toBe('en');
      await expect.poll(() => second.getByRole('link', { name: 'Pair server', exact: true }).count()).toBe(0);
      // Return to Chinese and record the phone-width default view.
      await openPreferences(second);
      await second.getByLabel('Language', { exact: true }).selectOption('zh-CN');
      await second.getByRole('button', { name: '完成', exact: true }).click();
      await second.screenshot({ path: join(home, 'language-zh-CN-390.png'), animations: 'disabled' });
      await second.close();
      expect(errors).toEqual([]);
      // A phone viewport and a keyboard-sized resize keep the composer visible. The language dance above left the
      // first page on the chat list in Chinese, so reopen the chat and find the composer in either language.
      await (await openNavigation(page, 'en'))
        .getByRole('link', { name: /Hello from Swiftnest/ })
        .first()
        .click();
      const phoneComposer = page.getByRole('textbox', { name: /^(Write a message|输入消息)$/ });
      for (const height of [844, 440]) {
        await page.setViewportSize({ width: 390, height });
        await phoneComposer.focus();
        const rect = await phoneComposer.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.y).toBeGreaterThanOrEqual(0);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      }
      await page.getByRole('button', { name: /^(Go back|返回)$/ }).click();
      await openPreferences(page);
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.close();
    } catch (error) {
      const body = await page
        ?.locator('body')
        .innerText()
        .catch(() => 'No page');
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${diagnostics.join('\n')}\n${body}\n${logs.slice(-30).join('\n')}`.replace(
          /token(?:=|%3D)[^&\s]+/gi,
          'token=REDACTED',
        ),
      );
    } finally {
      perchRun?.stop();
      await perchRun?.finished;
      await perch?.close();
      await browser.close();
      await kernel?.stop();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      if (home) await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);
