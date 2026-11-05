import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { webAppUrl } from '../../server/src/pairing';
import { contrastRatio } from '../src/design/palette';
import { translate, type Locale } from '../src/i18n';
import { launchChromium } from './browser';
import { MemoryHarness } from './fixtures/memoryHarness';
import { openNavigation, openPreferences } from './navigation';

async function capture(page: Page, label: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scope = (await page.getByRole('dialog').isVisible()) ? page.getByRole('dialog') : page.locator('.app-shell');
  for (const control of await scope.locator('button, a, textarea').filter({ visible: true }).all()) {
    if (await control.evaluate((el) => el.classList.contains('skip-link'))) continue;
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  if (process.env.SWIFTNEST_UI_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SWIFTNEST_UI_SCREENSHOT_DIR}/${label}.png`, animations: 'disabled' });
}

async function checkMessages(page: Page) {
  const messages = page.locator('.message');
  expect(await messages.count()).toBeGreaterThanOrEqual(2);
  expect((await messages.first().boundingBox())!.y).toBeLessThan(200);
  expect(await page.locator('.message time[datetime]').count()).toBe(await messages.count());
  const assistant = page.locator('.message:not(.message--own) .message__body').first();
  expect(await assistant.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('20px');
  expect(await assistant.evaluate((el) => getComputedStyle(el).borderWidth)).toBe('1px');
  expect(await assistant.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  const own = page.locator('.message--own .message__body').first();
  expect(await own.evaluate((el) => getComputedStyle(el).borderBottomRightRadius)).toBe('12px');
  expect(await own.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
  const colors = await own.evaluate((el) => {
    const style = getComputedStyle(el);
    const hex = (value: string) => {
      const context = document.createElement('canvas').getContext('2d')!;
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return (
        '#' +
        [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('')
      );
    };
    const accent = style.getPropertyValue('--color-accent');
    return [hex(style.color), hex(accent), hex(style.getPropertyValue('--chat-gradient-start'))];
  });
  for (const background of colors.slice(1)) expect(contrastRatio(colors[0]!, background)).toBeGreaterThanOrEqual(4.5);
}

async function checkTraceAndIcons(page: Page) {
  const trace = page.locator('.tool-trace').first();
  const target = await trace.locator('summary').boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
  expect(target!.width).toBeGreaterThanOrEqual(44);
  expect(await trace.getAttribute('open')).toBeNull();
  expect(await trace.locator('pre').isVisible()).toBe(false);
  await trace.locator('summary').click();
  expect(await trace.locator('pre').isVisible()).toBe(true);
  await trace.locator('summary').click();
  expect(await trace.locator('pre').isVisible()).toBe(false);
  for (const icon of await page
    .locator('.page-header[data-chat="true"] svg, .composer--chat svg, .tool-trace svg')
    .all()) {
    expect(await icon.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(await icon.getAttribute('stroke-width')).toBe('1.7');
  }
  const send = page.locator('.composer--chat .composer-send');
  expect(await send.evaluate((el) => getComputedStyle(el, '::before').width)).toBe('34px');
  expect(await send.evaluate((el) => getComputedStyle(el, '::before').height)).toBe('34px');
}

async function checkEmpty(page: Page, sessionId: string, locale: Locale) {
  await page.evaluate((id) => {
    location.hash = `/chats/${id}`;
  }, sessionId);
  const ideas = page.locator('.chat-empty__suggestions button');
  await ideas.first().waitFor();
  expect(await ideas.count()).toBe(2);
  await ideas.first().click();
  expect(await page.locator('[data-composer]').inputValue()).toBe(translate(locale, 'home.plan'));
  expect(await page.locator('[data-composer]').evaluate((el) => document.activeElement === el)).toBe(true);
  expect(await page.locator('.message').count()).toBe(0);
}

async function checkMatrix(page: Page, locale: Locale, chatId: string, emptyId: string) {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(colorScheme);
      const label = `b1-${locale}-${colorScheme}-${width}`;
      await page.evaluate(() => {
        location.hash = '/';
      });
      await page.locator('.home-greeting').waitFor();
      await capture(page, `${label}-home`);
      await openNavigation(page, locale);
      await capture(page, `${label}-drawer`);
      if (width === 390) await page.keyboard.press('Escape');
      await openPreferences(page, locale);
      await capture(page, `${label}-settings`);
      await page.keyboard.press('Escape');
      await page.evaluate((id) => {
        location.hash = `/chats/${id}`;
      }, chatId);
      await page.locator('.message time').first().waitFor();
      await checkMessages(page);
      await checkTraceAndIcons(page);
      await capture(page, `${label}-chat`);
      await checkEmpty(page, emptyId, locale);
      await capture(page, `${label}-empty-chat`);
    }
  }
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'chat visual hierarchy: real replay timestamps, collapsed trace, contrast, suggestions and complete screenshot matrix',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      const chat = await harness.client.createSession();
      await harness.turn(chat.sessionId, 'remember-now');
      const empty = await harness.client.createSession();
      for (const locale of ['zh-CN', 'en'] as const) {
        await harness.client.setLanguage(locale);
        const page = await browser.newPage({ reducedMotion: 'reduce' });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript((lang) => localStorage.setItem('swiftnest.locale', lang), locale);
        await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
        await page.locator('.home-greeting').waitFor();
        await checkMatrix(page, locale, chat.sessionId, empty.sessionId);
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
