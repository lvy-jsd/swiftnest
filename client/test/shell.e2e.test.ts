import { expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { MemoryHarness } from './fixtures/memoryHarness';
import { launchChromium } from './browser';
import { openNavigation, openPreferences } from './navigation';
import { webAppUrl } from '../../server/src/pairing';
import { translate, type Locale } from '../src/i18n';

async function capture(page: Page, label: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scope = (await page.getByRole('dialog').isVisible()) ? page.getByRole('dialog') : page.locator('.app-shell');
  for (const control of await scope.locator('button, a, input, textarea').filter({ visible: true }).all()) {
    if (await control.evaluate((element) => element.classList.contains('skip-link'))) continue;
    const box = await control.boundingBox();
    expect(box!.width, (await control.getAttribute('aria-label')) ?? undefined).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  if (process.env.SWIFTNEST_UI_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SWIFTNEST_UI_SCREENSHOT_DIR}/${label}.png`, animations: 'disabled' });
}

async function checkDrawer(page: Page, locale: Locale, label: string) {
  const drawer = await openNavigation(page, locale);
  expect(await drawer.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(/^rgb\(/);
  expect(await drawer.evaluate((element) => getComputedStyle(element, '::backdrop').backgroundColor)).toBe(
    'rgba(0, 0, 0, 0.4)',
  );
  await capture(page, `${label}-drawer`);
  for (let index = 0; index < 15; index++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  for (let index = 0; index < 15; index++) {
    await page.keyboard.press('Shift+Tab');
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect.poll(() => drawer.isVisible()).toBe(false);
  expect(
    await page
      .getByRole('button', { name: translate(locale, 'shell.openNavigation') })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true);
  await openNavigation(page, locale);
  await page.mouse.click(385, 400);
  await expect.poll(() => drawer.isVisible()).toBe(false);
}

async function settingsRoutes(page: Page, locale: Locale) {
  for (const route of ['models', 'plugins'] as const) {
    const preferences = await openPreferences(page, locale);
    await preferences.getByRole('button', { name: translate(locale, `shell.${route}`), exact: true }).click();
    await expect.poll(() => page.url().split('#')[1]).toBe(`/${route}`);
    expect(await preferences.isVisible()).toBe(false);
    await page.getByRole('button', { name: translate(locale, 'back'), exact: true }).click();
  }
}

async function checkHomeNavigation(page: Page, locale: Locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  await page.getByRole('button', { name: t('home.plan'), exact: true }).waitFor();
  await page.getByRole('button', { name: t('home.plan'), exact: true }).click();
  expect(await page.getByRole('textbox', { name: t('composer') }).inputValue()).toBe(t('home.plan'));
  await page.getByRole('button', { name: t('newChat'), exact: true }).click();
  expect(page.url()).not.toContain('#/chats/');
  expect(await page.getByRole('textbox', { name: t('composer') }).inputValue()).toBe(t('home.plan'));
  await expect
    .poll(() => page.locator('[data-composer]').evaluate((element) => element === document.activeElement))
    .toBe(true);
  const nav = await openNavigation(page, locale);
  await page.keyboard.press('Control+k');
  expect(await nav.getByRole('searchbox').evaluate((element) => element === document.activeElement)).toBe(true);
  expect(await nav.locator('a[href="#/models"], a[href="#/plugins"]').count()).toBe(0);
  const running = nav.getByRole('button', { name: t('shell.runningChats'), exact: true });
  await running.click();
  expect(await running.getAttribute('aria-pressed')).toBe('true');
  expect(await running.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    await running.evaluate((element) => getComputedStyle(element.closest('.sidebar-content')!).color),
  );
  expect(await nav.locator('.chat-link').count()).toBe(0);
  await nav.getByRole('button', { name: t('shell.allChats'), exact: true }).click();
  await nav.getByRole('searchbox').fill('no-matching-session');
  expect(await nav.locator('.chat-link').count()).toBe(0);
  await nav.getByRole('searchbox').fill('');
  expect(await nav.locator('.chat-link').count()).toBeGreaterThan(0);
  if (page.viewportSize()?.width === 390) await page.keyboard.press('Escape');
}

async function checkDraftRoutes(page: Page, locale: Locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const composer = page.getByRole('textbox', { name: t('composer') });
  await composer.fill(t('home.explain'));
  await page.getByRole('button', { name: t('newChat'), exact: true }).click();
  await expect.poll(() => composer.inputValue()).toBe(t('home.plan'));
  await (await openNavigation(page, locale)).locator('.chat-link').first().click();
  await expect.poll(() => composer.inputValue()).toBe(t('home.explain'));
  await page.getByRole('button', { name: t('back'), exact: true }).click();
}

async function checkShell(page: Page, locale: Locale, width: number, mode: 'light' | 'dark') {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.emulateMedia({ colorScheme: mode });
  const label = `shell-${locale}-${mode}-${width}`;
  await checkHomeNavigation(page, locale);
  await page.mouse.click(width - 12, 200);
  await capture(page, `${label}-home`);
  if (width === 390) await checkDrawer(page, locale, label);
  await settingsRoutes(page, locale);
  await (await openNavigation(page, locale)).locator('.chat-link').first().click();
  await page.getByRole('list', { name: t('messages'), exact: true }).waitFor();
  await capture(page, `${label}-chat`);
  if (width === 390) {
    await page.setViewportSize({ width, height: 440 });
    const box = await page.getByRole('textbox', { name: t('composer') }).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(440);
    await page.setViewportSize({ width, height: 844 });
  }
  await checkDraftRoutes(page, locale);
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'shell: real home send, suggestions, drawer, settings, light/dark screenshots and target sizes',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      for (const locale of ['zh-CN', 'en'] as const) {
        await harness.client.setLanguage(locale);
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
        await page.getByRole('button', { name: translate(locale, 'home.plan'), exact: true }).waitFor();
        expect(await page.locator('#main-content').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
          'none',
        );
        await expect
          .poll(() => page.locator('.sr-only').textContent())
          .toBe(await page.locator('.home-greeting h1').textContent());
        await page.keyboard.press('Tab');
        expect(await page.locator(':focus-visible').count()).toBeGreaterThan(0);
        await page.getByRole('button', { name: translate(locale, 'home.plan'), exact: true }).click();
        await page.getByRole('button', { name: translate(locale, 'send'), exact: true }).click();
        const messages = page.getByRole('list', { name: translate(locale, 'messages') });
        await messages.getByText('Done.', { exact: true }).waitFor();
        expect(await messages.getByText(translate(locale, 'home.plan'), { exact: true }).count()).toBe(1);
        await page.getByRole('button', { name: translate(locale, 'back'), exact: true }).click();
        for (const width of [390, 1440])
          for (const mode of ['light', 'dark'] as const) await checkShell(page, locale, width, mode);
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  150_000,
);
