import { expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { MemoryHarness } from './fixtures/memoryHarness';
import { launchChromium } from './browser';
import { webAppUrl } from '../../server/src/pairing';
import { translate, type Locale } from '../src/i18n';
import { openNavigation } from './navigation';

async function checkPageHeader(page: Page, locale: Locale, route: string, mode: string) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const header = page.locator('.main-content .page > .page-header');
  await header.waitFor();
  expect(await page.locator('.main-content > .phone-header').count()).toBe(0);
  expect(await header.count()).toBe(1);
  expect(await header.getByRole('button', { name: t('shell.openNavigation'), exact: true }).count()).toBe(1);
  expect(await header.getByRole('button', { name: t('back'), exact: true }).count()).toBe(1);
  expect(await header.getByRole('button', { name: t('openPreferences'), exact: true }).count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await openNavigation(page, locale);
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      header
        .getByRole('button', { name: t('shell.openNavigation') })
        .evaluate((element) => element === document.activeElement),
    )
    .toBe(true);
  await header.getByRole('button', { name: t('openPreferences'), exact: true }).click();
  await page.getByRole('dialog', { name: t('preferences'), exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: t('preferences'), exact: true }).waitFor({ state: 'hidden' });
  await page.mouse.click(385, 12);
  const heading = await header.locator(':scope > .page-header__row > .page-header__titles').boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(0);
  expect(heading!.x).toBeGreaterThanOrEqual(0);
  expect(heading!.x + heading!.width).toBeLessThanOrEqual(390);
  if (process.env.SWIFTNEST_UI_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.SWIFTNEST_UI_SCREENSHOT_DIR}/shell-${locale}-${mode}-390-${route}.png`,
      animations: 'disabled',
    });
}

async function checkChatHeader(page: Page, locale: Locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const header = page.locator('.page-header[data-chat="true"]');
  expect(await header.getByRole('button').count()).toBe(4);
  const titleText = await header.locator('.chat-title__name').innerText();
  expect(await header.getByRole('heading', { name: titleText, exact: true }).count()).toBe(1);
  expect(await header.getByRole('button', { name: t('openPreferences') }).getAttribute('class')).toBe('chat-title');
  const menu = await header.getByRole('button', { name: t('shell.openNavigation') }).boundingBox();
  const title = await header.locator('.chat-title').boundingBox();
  const pencil = await header.getByRole('button', { name: t('newChat'), exact: true }).boundingBox();
  expect(title!.x).toBeGreaterThan(menu!.x + menu!.width);
  expect(pencil!.x).toBeGreaterThan(title!.x + title!.width);
  expect(title!.y + title!.height / 2).toBeCloseTo(menu!.y + menu!.height / 2, 0);
  expect(pencil!.y).toBeCloseTo(menu!.y, 0);
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'phone routes have one header, one preferences entry, working drawer/back, and aligned chat title and pencil',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      const { sessionId } = await harness.client.createSession();
      await harness.turn(sessionId, 'first message');
      for (const locale of ['zh-CN', 'en'] as const) {
        await harness.client.setLanguage(locale);
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        await page.addInitScript((locale) => localStorage.setItem('swiftnest.locale', locale), locale);
        await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
        await page.getByRole('button', { name: translate(locale, 'newChat'), exact: true }).waitFor();
        await page.getByRole('button', { name: translate(locale, 'home.plan'), exact: true }).waitFor();
        for (const mode of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: mode });
          for (const route of ['devices', 'memory', 'transfers', 'models', 'plugins', 'pair', `chats/${sessionId}`]) {
            await page.evaluate((route) => {
              window.location.hash = `/${route}`;
            }, route);
            await checkPageHeader(page, locale, route.startsWith('chats/') ? 'chat-header' : route, mode);
            if (route.startsWith('chats/')) await checkChatHeader(page, locale);
            await page.getByRole('button', { name: translate(locale, 'back'), exact: true }).click();
            await page.getByRole('button', { name: translate(locale, 'home.plan'), exact: true }).waitFor();
          }
        }
        await page.close();
      }
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  120_000,
);
