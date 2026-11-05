import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { webAppUrl } from '../../server/src/pairing';
import { launchChromium } from './browser';
import { MemoryHarness } from './fixtures/memoryHarness';
import { openNavigation } from './navigation';

/** End one session stream after its snapshot, leaving the connection and other streams healthy. */
async function interruptFirstFollow(page: Page) {
  let follows = 0;
  await page.routeWebSocket('**/api/remote.mux', (socket) => {
    const server = socket.connectToServer();
    let firstFollow: string | undefined;
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'open' && frame.endpoint === 'session/follow') {
        if (++follows === 1) firstFollow = frame.streamId;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      socket.send(message);
      const frame = JSON.parse(String(message));
      if (frame.streamId !== firstFollow || frame.type !== 'item' || frame.value.type !== 'snapshot') return;
      server.send(JSON.stringify({ type: 'cancel', streamId: firstFollow }));
      socket.send(JSON.stringify({ type: 'end', streamId: firstFollow }));
      firstFollow = undefined;
    });
  });
  return () => follows;
}

async function checkRecovery(page: Page, sessionId: string, follows: () => number) {
  await (await openNavigation(page)).locator(`a[href="#/chats/${sessionId}"]`).click();
  const messages = page.getByRole('list', { name: 'Messages', exact: true });
  await messages.getByText('Done.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('draft after interrupted follow');
  await page.locator('.page-header').getByText('Connected', { exact: true }).waitFor();
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect.poll(() => send.isEnabled(), { timeout: 5000 }).toBe(true);
  expect(follows()).toBeGreaterThanOrEqual(2);
  await send.click();
  await messages.getByText('draft after interrupted follow', { exact: true }).waitFor();
  await expect.poll(() => messages.getByText('Done.', { exact: true }).count()).toBe(2);
  expect(await messages.getByText('draft after interrupted follow', { exact: true }).count()).toBe(1);
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'a connected chat recovers an ended follow stream and sends the retained draft once',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      const { sessionId } = await harness.client.createSession();
      await harness.turn(sessionId, 'first message');
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const follows = await interruptFirstFollow(page);
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
      await page.waitForURL((url) => url.hash === '#/');
      await checkRecovery(page, sessionId, follows);
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  60_000,
);
