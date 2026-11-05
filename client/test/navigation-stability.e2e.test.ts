import { expect, it } from 'vitest';
import type { ElementHandle, Page } from '@playwright/test';
import { MemoryHarness } from './fixtures/memoryHarness';
import { launchChromium } from './browser';
import { webAppUrl } from '../../server/src/pairing';

async function watchResizeAnimations(page: Page) {
  await page.evaluate(() => {
    Object.assign(window, { __resizeEntries: 0 });
    document.addEventListener('animationstart', (event) => {
      if ((event.target as Element).classList.contains('route-view')) (window as any).__resizeEntries++;
    });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.classList.contains('route-view')) (window as any).__resizeEntries++;
      return animate.apply(this, args);
    };
  });
}

async function checkResizes(page: Page, route: ElementHandle<HTMLElement | SVGElement>) {
  const composer = page.getByRole('textbox', { name: 'Write a message' });
  const input = await composer.elementHandle();
  const chat = await page.locator('.page--detail').elementHandle();
  await watchResizeAnimations(page);
  for (const [width, height] of [
    [390, 844],
    [390, 440],
    [390, 844],
    [600, 844],
    [599, 844],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await input!.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
    expect(await route.evaluate((element) => element === document.querySelector('.route-view'))).toBe(true);
    expect(await chat!.evaluate((element) => element === document.querySelector('.page--detail'))).toBe(true);
    expect(await page.evaluate(() => (window as any).__resizeEntries)).toBe(0);
    expect(await route.evaluate((element) => element.getAnimations().length)).toBe(0);
    expect(await composer.inputValue()).toBe('keep my focus and draft');
    const rect = await composer.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
  }
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'resizing a focused chat across breakpoints and keyboard heights keeps its nodes, focus and geometry without entry animations',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
      const route = await page.locator('.route-view').elementHandle();
      const composer = page.getByRole('textbox', { name: 'Write a message' });
      await composer.fill('first message');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('list', { name: 'Messages' }).getByText('Done.', { exact: true }).waitFor();
      await composer.focus();
      expect(await composer.boundingBox()).not.toBeNull();
      await page
        .locator('.route-view')
        .evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
      await composer.fill('keep my focus and draft');
      await checkResizes(page, route!);
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  90_000,
);
