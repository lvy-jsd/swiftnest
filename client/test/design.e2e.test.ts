/** Built assets, local fonts and native dialog behavior in real Chromium. No kernel needed. */
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import type { Browser, Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { launchChromium } from './browser';
import { translate, type Locale } from '../src/i18n';

async function checkSheet(page: Page, locale: Locale, mode: 'light' | 'dark') {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const sheet = page.getByRole('dialog', { name: t('preferences'), exact: true });
  await sheet
    .getByRole('group', { name: t('appearance') })
    .getByRole('button', { name: t(mode), exact: true })
    .click();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(mode);
  expect(await sheet.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(34, 37, 45)',
  );
  expect(await sheet.getAttribute('class')).toBe('sheet');
  expect(await sheet.evaluate((element) => getComputedStyle(element, '::backdrop').backgroundColor)).toBe(
    'rgba(0, 0, 0, 0.4)',
  );
  const box = await sheet.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(viewport.width);
  if (viewport.width < 600) expect(box!.y + box!.height).toBeCloseTo(viewport.height, 0);
  else expect(box!.y + box!.height / 2).toBeCloseTo(viewport.height / 2, 0);
  if (process.env.SWIFTNEST_UI_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.SWIFTNEST_UI_SCREENSHOT_DIR}/${locale}-${mode}-${viewport.width}.png`,
    });
  for (const control of await sheet.locator('button, input, select').filter({ visible: true }).all()) {
    const target = await control.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
  }
}

async function checkChoices(page: Page, locale: Locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const sheet = page.getByRole('dialog', { name: t('preferences'), exact: true });
  const accent = sheet.getByRole('group', { name: t('accent') });
  for (const key of ['iris', 'ocean', 'jade', 'amber', 'rose', 'custom'] as const) {
    const chip = accent.getByRole('button', { name: t(key), exact: true });
    await chip.click();
    expect(await chip.getAttribute('aria-pressed')).toBe('true');
    expect(await accent.locator('[aria-pressed="true"]').count()).toBe(1);
  }
  await sheet.getByLabel(t('customHue'), { exact: true }).fill('123');
  expect(await sheet.getByLabel(t('customHue'), { exact: true }).inputValue()).toBe('123');
  await sheet.getByLabel(t('reduceTransparency'), { exact: true }).check();
  expect(
    await sheet
      .locator('.card')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toMatch(/^rgb\(/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.locator('html').getAttribute('data-reduce-motion')).toBe('false');
  await sheet.getByLabel(t('reduceMotion'), { exact: true }).check();
  expect(
    await page
      .locator('html')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).getPropertyValue('--duration-navigation'))),
  ).toBe(0);
  await checkFocusLoop(page, locale);
}

async function checkFocusLoop(page: Page, locale: Locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const sheet = page.getByRole('dialog', { name: t('preferences'), exact: true });
  await sheet.getByRole('button', { name: t('close'), exact: true }).focus();
  await page
    .locator('.sidebar button')
    .first()
    .evaluate((element) => (element as HTMLButtonElement).focus());
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    const active = await page.evaluate(() => document.activeElement?.tagName);
    expect(await sheet.evaluate((element) => element.contains(document.activeElement)), active).toBe(true);
  }
}

async function checkLocale(browser: Browser, url: string, locale: Locale) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const external: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(url).origin) external.push(request.url());
  });
  await page.addInitScript((value) => localStorage.setItem('swiftnest.locale', value), locale);
  await page.goto(url);
  const open = page
    .getByRole('button', { name: translate(locale, 'openPreferences'), exact: true })
    .filter({ visible: true })
    .first();
  await open.click();
  for (const width of [390, 1100]) {
    await page.setViewportSize({ width, height: 844 });
    for (const mode of ['light', 'dark'] as const) await checkSheet(page, locale, mode);
  }
  await checkChoices(page, locale);
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() =>
    [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family),
  );
  expect(fonts).toContain('Inter Variable');
  if (locale === 'zh-CN') expect(fonts).toContain('Noto Sans SC Variable');
  expect(external).toEqual([]);
  await page.keyboard.press('Escape');
  expect(await page.getByRole('dialog').count()).toBe(0);
  await open.click();
  await page.mouse.click(2, 2);
  await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
  await page.close();
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  '晨巢: local fonts, responsive opaque sheets, choices and keyboard dismissal',
  async () => {
    const server = await preview({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: false,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    });
    const browser = await launchChromium();
    try {
      for (const locale of ['zh-CN', 'en'] as const) await checkLocale(browser, server.resolvedUrls!.local[0]!, locale);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  60_000,
);
