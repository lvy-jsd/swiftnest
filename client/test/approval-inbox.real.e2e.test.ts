import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ApprovalHarness } from './fixtures/approvalHarness.js';
import { webAppUrl } from '../../server/src/pairing.js';
import { launchChromium } from './browser.js';
import { openNavigation } from './navigation';

it.skipIf(process.env.SWIFTNEST_E2E !== '1' || process.env.SWIFTNEST_WEB_E2E !== '1')(
  'real App shows the shared inbox everywhere and settles from another device at desktop and 390px',
  async () => {
    const harness = new ApprovalHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token, harness.kernel!.channelPairing));
      await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
      const pending = await openPending(page, harness);
      await answerAndReopenChat(page, harness, pending.sessionId, pending.deviceId);
      await checkSettings(page, harness);
      const decisions = (await harness.client!.deviceAudit()).filter((entry) => entry.approval);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]!.approval!.answeringDevice).not.toBe(decisions[1]!.approval!.answeringDevice);
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}\n${harness.logs.slice(-40).join('\n')}`, { cause: error });
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  90000,
);

async function openPending(page: Page, harness: ApprovalHarness) {
  const session = await harness.client!.createSession();
  // No App is following this chat while the request is created.
  await harness.client!.sendMessage(session.sessionId, 'request-approval');
  const device = await harness.writeRequest();
  const badge = page.getByRole('link', { name: 'Approvals · 2 pending', exact: true });
  await badge.waitFor();
  await badge.click();
  const list = page.getByRole('list', { name: 'Approvals', exact: true });
  await list.getByText('Read the shared report?', { exact: true }).waitFor();
  await list.getByText('Test computer', { exact: true }).waitFor();
  await list
    .getByRole('article')
    .filter({ hasText: 'Read the shared report?' })
    .getByText('Details', { exact: true })
    .click();
  expect(await list.innerText()).toContain('/shared/report.txt');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/swiftnest-a1-inbox-390.png', fullPage: true, animations: 'disabled' });
  return { sessionId: session.sessionId, deviceId: device.id };
}
async function answerAndReopenChat(page: Page, harness: ApprovalHarness, sessionId: string, deviceId: string) {
  const list = page.getByRole('list', { name: 'Approvals', exact: true });
  const dsh = list.getByRole('article').filter({ hasText: 'Read the shared report?' });
  await dsh.getByRole('button', { name: 'Approve', exact: true }).click();
  await openNavigation(page);
  await page.getByRole('link', { name: 'Approvals · 1 pending', exact: true }).waitFor();
  // Another authenticated App answers the remaining request.
  await harness.client!.answerDeviceApproval(deviceId, true);
  await page.getByRole('link', { name: 'Approvals · 0 pending', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('Nothing needs your approval.', { exact: true }).waitFor();
  expect(await readFile(join(harness.home, 'approved.txt'), 'utf8')).toBe('Approved from inbox');
  await page.evaluate((id) => {
    location.hash = `/chats/${id}`;
  }, sessionId);
  const transcript = page.getByRole('list', { name: 'Messages', exact: true });
  await transcript.getByText('This approval request has ended.', { exact: true }).waitFor();
  await transcript.getByText('Done.', { exact: true }).waitFor();
  expect(await transcript.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
  for (const path of ['/devices', '/transfers', '/memory']) {
    await page.evaluate((path) => {
      location.hash = path;
    }, path);
    await openNavigation(page);
    await page.getByRole('link', { name: 'Approvals · 0 pending', exact: true }).waitFor();
    await page.keyboard.press('Escape');
  }
}
async function checkSettings(page: Page, harness: ApprovalHarness) {
  await page.evaluate(() => {
    location.hash = '/';
  });
  await page.getByRole('button', { name: 'Open preferences', exact: true }).click();
  const settings = page.getByRole('group', { name: 'Approvals', exact: true });
  const remind = settings.getByRole('switch', { name: 'Remind me when my approval is needed', exact: true });
  expect(await remind.isChecked()).toBe(true);
  await remind.click();
  await expect.poll(async () => (await harness.client!.approvalInbox()).settings.remind).toBe(false);
  expect(
    await settings.getByRole('switch', { name: 'Automatically allow low-risk actions', exact: true }).count(),
  ).toBe(0);
  const advanced = settings.getByText('Advanced options', { exact: true });
  expect((await advanced.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await advanced.click();
  expect(
    await settings.getByRole('switch', { name: 'Automatically allow low-risk actions', exact: true }).isChecked(),
  ).toBe(false);
  await settings.getByRole('spinbutton', { name: 'File transfers', exact: true }).fill('120');
  await settings.getByRole('spinbutton', { name: 'File transfers', exact: true }).press('Tab');
  await expect.poll(async () => (await harness.client!.approvalInbox()).settings.timeouts.transfer).toBe(120000);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}
