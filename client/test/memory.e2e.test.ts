import { expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { launchChromium } from './browser';
import { MemoryHarness } from './fixtures/memoryHarness';
import { webAppUrl } from '../../server/src/pairing';
import { translate, type Locale } from '../src/i18n';

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'Memory page edits central memory in English and Chinese at phone width',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      for (const locale of ['en', 'zh-CN'] as const) {
        await harness.client.setLanguage(locale);
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
        await page
          .getByRole('main')
          .getByRole('link', { name: translate(locale, 'memory'), exact: true })
          .click();
        await exerciseMemory(page, locale);
        // The App requires pairing again after a reload; memory still comes from the server.
        await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
        await page
          .getByRole('main')
          .getByRole('link', { name: translate(locale, 'memory'), exact: true })
          .click();
        await page.getByText(`Updated topic fact ${locale}`, { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await context.close();
      }
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  150_000,
);

async function exerciseMemory(page: Page, locale: Locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const value = `Owner fact ${locale}`;
  await page.getByLabel(t('memoryEntry'), { exact: true }).fill(value);
  await page.getByRole('button', { name: t('memoryAdd'), exact: true }).click();
  const item = page.locator('.memory-item').first();
  await item.getByText(value, { exact: true }).waitFor();
  await item.getByRole('button', { name: t('memoryEdit'), exact: true }).click();
  await item.getByLabel(t('memoryEntry'), { exact: true }).fill(`${value} edited`);
  await item.getByRole('button', { name: t('save'), exact: true }).click();
  await item
    .locator('p')
    .filter({ hasText: `${value} edited` })
    .waitFor();
  await page.getByLabel(t('memoryEntry'), { exact: true }).fill('password=do-not-store');
  await page.getByRole('button', { name: t('memoryAdd'), exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: locale === 'en' ? /password/ : /密码/ })
    .waitFor();
  await page.getByLabel(t('memoryTopicName'), { exact: true }).fill(`Topic ${locale}`);
  await page.getByLabel(t('memoryTopicContent'), { exact: true }).fill(`- A topic fact ${locale}`);
  await page.getByRole('button', { name: t('memorySaveTopic'), exact: true }).click();
  await page.getByRole('button', { name: `Topic ${locale}`, exact: true }).click();
  await expect
    .poll(() => page.getByLabel(t('memoryTopicContent'), { exact: true }).inputValue())
    .toContain(`A topic fact ${locale}`);
  await page.getByLabel(t('memoryTopicContent'), { exact: true }).fill(`- Updated topic fact ${locale}`);
  await page.getByRole('button', { name: t('memorySaveTopic'), exact: true }).click();
  await page.getByText(`Updated topic fact ${locale}`, { exact: true }).waitFor();
  await item.getByRole('button', { name: t('memoryDelete'), exact: true }).click();
  await expect.poll(() => page.getByText(`${value} edited`, { exact: true }).count()).toBe(0);
}
