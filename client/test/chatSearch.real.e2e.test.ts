import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { ChatSearchHarness, OLD_CHAT_TEXT } from './fixtures/chatSearchHarness';
import { launchChromium } from './browser';
import { webAppUrl } from '../../server/src/pairing';
import { translate, type Locale, type StringKey } from '../src/i18n';

const runs = process.env.SWIFTNEST_E2E === '1' && process.env.SWIFTNEST_WEB_E2E === '1';
it.skipIf(!runs).each([
  { locale: 'en' as const, width: 390 },
  { locale: 'zh-CN' as const, width: 1280 },
])(
  'real App chat search: $locale at $width px, opens chats and saves advanced settings',
  async ({ locale, width }) => {
    const harness = new ChatSearchHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      await harness.client.setLanguage(locale);
      const old = await harness.client.createSession();
      await harness.turn(old.sessionId, OLD_CHAT_TEXT);
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      if (locale === 'en') await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
      await searchAndOpen(page, old.sessionId, locale);
      if (width > 600) await searchSidebar(page, old.sessionId, locale);
      await advancedSettings(page, locale, harness);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}\n${harness.logs.slice(-60).join('\n')}`, { cause: error });
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  120_000,
);

async function searchAndOpen(page: Page, id: string, locale: Locale) {
  const main = page.getByRole('main');
  const t = (key: StringKey) => translate(locale, key);
  const search = main.getByRole('searchbox', { name: t('search') });
  await search.fill('杭州');
  const results = main.getByRole('list', { name: t('chatSearchResults') });
  await results.getByRole('link').first().waitFor();
  expect(await results.locator('mark').first().textContent()).toBe('杭州');
  expect(await results.locator('time').first().getAttribute('dateTime')).toBeTruthy();
  await search.fill('bicycle');
  await expect.poll(() => results.locator('mark').first().textContent()).toBe('bicycle');
  await results.getByRole('link').first().click();
  await expect.poll(() => page.url()).toContain(`#/chats/${id}`);
  await main.getByText(OLD_CHAT_TEXT, { exact: true }).waitFor();
}

async function searchSidebar(page: Page, id: string, locale: Locale) {
  const sidebar = page.getByRole('complementary');
  const t = (key: StringKey) => translate(locale, key);
  await sidebar.getByRole('searchbox', { name: t('search') }).fill('orchard');
  const results = sidebar.getByRole('list', { name: t('chatSearchResults') });
  await results.getByRole('link').first().waitFor();
  expect(await results.getByRole('link').first().getAttribute('href')).toBe(`#/chats/${id}`);
  expect(await results.locator('mark').first().isVisible()).toBe(true);
  await page
    .getByRole('main')
    .getByRole('button', { name: t('back') })
    .click();
  await page
    .getByRole('main')
    .getByRole('link', { name: t('devices'), exact: true })
    .click();
  await sidebar.getByRole('searchbox', { name: t('search') }).fill('杭州');
  await expect.poll(() => results.locator('mark').first().textContent()).toBe('杭州');
  await results.getByRole('link').first().click();
  await page.getByRole('main').getByText(OLD_CHAT_TEXT, { exact: true }).waitFor();
}

async function advancedSettings(page: Page, locale: Locale, harness: ChatSearchHarness) {
  const t = (key: StringKey) => translate(locale, key);
  await page.getByRole('button', { name: t('chatActions') }).click();
  const advanced = page.locator('details').filter({ has: page.getByText(t('chatSearchAdvanced'), { exact: true }) });
  expect(await advanced.getAttribute('open')).toBeNull();
  await advanced.locator('summary').click();
  const semantic = advanced.getByRole('switch', { name: t('chatSearchSemantic'), exact: true });
  await semantic.uncheck();
  await advanced.getByRole('button', { name: t('save'), exact: true }).click();
  await expect.poll(async () => (await harness.client.chatSearchStatus()).settings.semantic).toBe(false);
  await advanced.getByText(t('chatSearchSemanticOff'), { exact: true }).waitFor();
  const rebuild = advanced.getByRole('button', { name: t('chatSearchRebuild') });
  await rebuild.click();
  await expect.poll(() => rebuild.isEnabled()).toBe(true);
  expect((await harness.client.searchChats('杭州'))[0]?.snippet).toContain('杭州');
  await advanced.getByLabel(t('chatSearchSource')).selectOption('cloud');
  expect(await advanced.getByRole('switch', { name: t('chatSearchCloudConsent') }).isChecked()).toBe(false);
  expect(await advanced.getByRole('link', { name: t('chatSearchKeyHelp') }).getAttribute('href')).toBe('#/models');
  await advanced.getByRole('button', { name: t('save'), exact: true }).click();
  await expect.poll(async () => (await harness.client.chatSearchStatus()).settings.embeddings.source).toBe('cloud');
  await expect.poll(() => advanced.getByRole('button', { name: t('save'), exact: true }).isEnabled()).toBe(true);
  await advanced.locator('summary').click();
  await advanced.locator('summary').click();
  await expect.poll(() => advanced.getByLabel(t('chatSearchSource')).inputValue()).toBe('cloud');
}
