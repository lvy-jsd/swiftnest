import { expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { MemoryHarness } from './fixtures/memoryHarness';
import { launchChromium } from './browser';
import { webAppUrl } from '../../server/src/pairing';

type SocketProbe = Window & { dropChatSockets: () => void };
async function open(page: Page, id: string, text: string) {
  await page.evaluate((id) => {
    location.hash = `/chats/${id}`;
  }, id);
  await expect.poll(() => page.locator('.transcript').innerText(), { timeout: 25_000 }).toContain(text);
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'cache acceptance: hidden streaming, ten-second outage, seventy sessions and re-pair isolation',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await harness.start();
      const ids: string[] = [];
      // Real durable records and API follow streams, not a mocked reducer/store.
      for (let i = 0; i < 70; i++) {
        const { sessionId } = await harness.client.createSession();
        ids.push(sessionId);
        harness.replyText = `unique-reply-${i}`;
        await harness.turn(sessionId, `unique-prompt-${i}`);
      }
      await page.addInitScript(() => {
        localStorage.setItem('swiftnest.locale', 'en');
        const sockets = new Set<WebSocket>();
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            sockets.add(this);
            this.addEventListener('close', () => sockets.delete(this), { once: true });
          }
        };
        (window as unknown as SocketProbe).dropChatSockets = () => {
          for (const socket of sockets) socket.close();
        };
      });
      await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token, harness.kernel!.channelPairing));
      await page.locator('.home-greeting').waitFor();
      await open(page, ids[0]!, 'unique-reply-0');
      await expect.poll(() => page.getByRole('textbox', { name: 'Write a message' }).isEnabled()).toBe(true);

      // Scene 2: let a stream complete while its React view is unmounted for five seconds.
      harness.replyText = 'stream-one stream-two stream-three stream-four stream-five stream-six';
      harness.replyChunkDelayMs = 500;
      await page.getByRole('textbox', { name: 'Write a message' }).fill('stream-while-hidden');
      await page.getByRole('button', { name: 'Send message' }).click();
      await page.locator('[data-streaming="true"]').filter({ hasText: 'stream-one' }).waitFor();
      await open(page, ids[1]!, 'unique-reply-1');
      await page.waitForTimeout(5000);
      await open(page, ids[0]!, harness.replyText);
      expect(await page.locator('.message:not(.message--own)').filter({ hasText: harness.replyText }).count()).toBe(1);
      expect(await page.locator('[data-streaming="true"]').count()).toBe(0);
      harness.replyChunkDelayMs = 0;

      // Scene 3: force the real carrier closed while browser network is offline, then restore it.
      await context.setOffline(true);
      await page.evaluate(() => (window as unknown as SocketProbe).dropChatSockets());
      await page.waitForTimeout(10_000);
      await context.setOffline(false);
      await expect
        .poll(() => page.getByRole('textbox', { name: 'Write a message' }).isEnabled(), { timeout: 25_000 })
        .toBe(true);
      await open(page, ids[0]!, harness.replyText);
      expect(await page.locator('.message:not(.message--own)').filter({ hasText: harness.replyText }).count()).toBe(1);
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await page.locator('.inline-error').count()).toBe(0);

      // Scene 4: exceed the LRU cap, then restore the evicted view from the kernel.
      for (let i = 0; i < ids.length; i++) await open(page, ids[i]!, `unique-reply-${i}`);
      await open(page, ids[0]!, 'unique-reply-0');
      expect(await page.locator('.message--own').filter({ hasText: 'unique-prompt-0' }).count()).toBe(1);
      expect(await page.locator('.transcript').innerText()).not.toContain('unique-reply-69');

      // Scene 5: re-pair invalidates cached visible/hidden transcripts immediately.
      // Cancel the new pairing request so old history cannot be repopulated from its server.
      await page.route('**/*token=invalid-for-isolation-test*', (route) => route.abort());
      await page.evaluate(() => {
        location.hash = '/pair';
      });
      await page
        .getByRole('textbox', { name: 'Pairing URL', exact: true })
        .fill(new URL('connect?token=invalid-for-isolation-test', harness.kernel!.url).href);
      await page.getByRole('button', { name: 'Pair server', exact: true }).click();
      await page.waitForTimeout(250);
      await page.evaluate((id) => {
        location.hash = `/chats/${id}`;
      }, ids[0]!);
      await expect.poll(() => page.locator('.transcript').innerText()).not.toContain('unique-reply-0');
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await page.locator('body').innerText()}\n${errors.join('\n')}\n${harness.logs.slice(-20).join('\n')}`,
      );
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  240_000,
);
