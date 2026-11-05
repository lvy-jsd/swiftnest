import { expect, it } from 'vitest';
import type { Locator } from '@playwright/test';
import { launchChromium } from './browser';
import { MemoryHarness } from './fixtures/memoryHarness';
import { webAppUrl } from '../../server/src/pairing';
import { translate } from '../src/i18n';

it.skipIf(process.env.SWIFTNEST_E2E !== '1' || process.env.SWIFTNEST_WEB_E2E !== '1')(
  'automatic memory switch and one-tap deletion work in both languages at phone width',
  async () => {
    const harness = new MemoryHarness();
    harness.autoProposal = () => [{ op: 'add', text: 'Prefers a quiet workspace' }];
    const browser = await launchChromium();
    try {
      await harness.start(100);
      for (const locale of ['zh-CN', 'en'] as const) {
        await harness.client.setLanguage(locale);
        await harness.client.setMemoryAuto(true);
        const session = await harness.client.createSession();
        await harness.turn(session.sessionId, 'I always prefer a quiet workspace.');
        await expect.poll(async () => (await harness.client.recentAutoMemory()).length, { timeout: 15_000 }).toBe(1);
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
        const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
        await page
          .getByRole('main')
          .getByRole('link', { name: t('memory'), exact: true })
          .click();
        const toggle = page.getByRole('switch', { name: t('memoryAutoSwitch') });
        await toggle.waitFor();
        expect(await toggle.isChecked()).toBe(true);
        await expectSharedSwitchStyle(toggle);
        await toggle.click();
        await expect.poll(async () => (await harness.client.memoryAutoSettings()).enabled).toBe(false);
        await expect.poll(() => toggle.isEnabled()).toBe(true);
        await toggle.click();
        await expect.poll(async () => (await harness.client.memoryAutoSettings()).enabled).toBe(true);
        const recent = page.getByRole('region', { name: t('memoryAutoRecent') });
        await recent.getByText('Prefers a quiet workspace', { exact: true }).waitFor();
        expect(await recent.locator('time').getAttribute('datetime')).toBeTruthy();
        await recent.getByRole('button', { name: t('memoryDelete'), exact: true }).click();
        await expect.poll(async () => (await harness.client.recentAutoMemory()).length).toBe(0);
        await recent.getByText(t('memoryAutoEmpty'), { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await context.close();
      }
    } catch (error) {
      throw new Error(`${String(error)}\n${harness.logs.slice(-35).join('\n')}`, { cause: error });
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  120_000,
);

async function expectSharedSwitchStyle(toggle: Locator) {
  const style = await toggle.evaluate((input) => {
    const tokens = getComputedStyle(document.documentElement);
    return {
      height: getComputedStyle(input).height,
      minimumTarget: tokens.getPropertyValue('--min-target').trim(),
      thumbWidth: getComputedStyle(input, '::after').width,
      thumbToken: tokens.getPropertyValue('--space-xl').trim(),
      trackRadius: getComputedStyle(input, '::before').borderRadius,
      radiusToken: tokens.getPropertyValue('--radius-pill').trim(),
    };
  });
  expect(style.height).toBe(style.minimumTarget);
  expect(style.thumbWidth).toBe(style.thumbToken);
  expect(style.trackRadius).toBe(style.radiusToken);
}
