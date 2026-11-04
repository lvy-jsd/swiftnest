import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { launchChromium } from './browser';
import { translate } from '../src/i18n';

async function screenshot(page: Page, name: string) {
  const directory = process.env.SWIFTNEST_UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
}
async function checkTargets(page: Page, selector: string) {
  for (const element of await page.locator(`${selector} button, ${selector} summary`).filter({ visible: true }).all()) {
    const box = (await element.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}
async function checkLayout(page: Page, width: number, mode: string) {
  await page.locator('.device-tile').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator('html').getAttribute('data-theme')).toBe(mode);
  const columns = await page
    .locator('.devices-grid')
    .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(width < 600 ? 1 : width < 1024 ? 2 : 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await checkTargets(page, '.devices-page');
  await screenshot(page, `devices-${mode}-${width}`);
  expect(
    await page
      .locator('.device-tile--offline')
      .getByRole('button', { name: translate('zh-CN', 'devicesViewScreen') })
      .count(),
  ).toBe(0);
  await page.getByRole('button', { name: translate('zh-CN', 'devicesViewScreen'), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('img').waitFor();
  expect(await page.locator('.live-surface--phone').count()).toBe(1);
  const stage = (await page.locator('.live-stage').boundingBox())!;
  const tools = (await page.locator('.live-tools').boundingBox())!;
  if (width < 1024) expect(tools.y).toBeGreaterThan(stage.y + stage.height);
  else expect(tools.x).toBeGreaterThan(stage.x + stage.width);
  expect(await dialog.getByRole('button', { name: '暂停', exact: true }).count()).toBe(0);
  expect(await dialog.getByRole('button', { name: '停止任务', exact: true }).count()).toBe(0);
  await checkTargets(page, '.live-panel');
  await screenshot(page, `live-view-${mode}-${width}`);
  // Viewing never grants input control. Only an explicit take-over does.
  expect(await page.evaluate(() => (window as any).__devicesUI.calls.includes('take'))).toBe(false);
  await dialog.getByRole('button', { name: translate('zh-CN', 'liveTakeOver'), exact: true }).click();
  await dialog.getByText(translate('zh-CN', 'youControl'), { exact: true }).waitFor();
  await dialog.getByRole('button', { name: translate('zh-CN', 'handBack'), exact: true }).click();
  await dialog.getByText(translate('zh-CN', 'ivyControl'), { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
  expect(
    await page
      .getByRole('button', { name: translate('zh-CN', 'devicesViewScreen'), exact: true })
      .evaluate((e) => e === document.activeElement),
  ).toBe(true);
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'devices and live view: responsive layout, consent, light/dark screenshots',
  async () => {
    const server = await createServer({
      root: resolve('client'),
      cacheDir: resolve('node_modules/.cache/swiftnest/devices-design'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'devices-design-fixture',
          configureServer(s) {
            s.middlewares.use('/__devices_ui', async (_req, res) => {
              res.setHeader('content-type', 'text/html');
              res.end(
                await s.transformIndexHtml(
                  '/__devices_ui',
                  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/fixtures/devicesUI.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await launchChromium();
    try {
      for (const width of [390, 768, 1440]) {
        for (const mode of ['light', 'dark'] as const) {
          const page = await browser.newPage({
            viewport: { width, height: width === 1440 ? 900 : 844 },
            colorScheme: mode,
            reducedMotion: 'reduce',
          });
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${server.resolvedUrls!.local[0]}__devices_ui`);
          await checkLayout(page, width, mode);
          // A disconnect closes viewing; reconnecting cannot reopen it without another click.
          await page.getByRole('button', { name: translate('zh-CN', 'devicesViewScreen'), exact: true }).click();
          await page.getByRole('dialog').getByRole('img').waitFor();
          await page.evaluate(() => (window as any).__devicesUI.setConnection(false));
          await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
          await page.evaluate(() => (window as any).__devicesUI.setConnection(true));
          await page.locator('.device-tile').first().waitFor();
          expect(await page.getByRole('dialog').count()).toBe(0);
          const accept = !(width === 390 && mode === 'dark');
          await page
            .getByRole('button', { name: translate('zh-CN', accept ? 'devicesAllowPairing' : 'deny'), exact: true })
            .click();
          expect(
            await page.evaluate(
              (accepted) =>
                (window as any).__devicesUI.calls.some((c: any) => c.pairing === 'candidate' && c.accept === accepted),
              accept,
            ),
          ).toBe(true);
          await page.getByRole('button', { name: translate('zh-CN', 'pairDevice'), exact: true }).click();
          await page.locator('.pairing-code').waitFor();
          expect(await page.locator('.pairing-code').innerText()).toBe('482913');
          expect(errors).toEqual([]);
          await page.close();
        }
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
  60_000,
);
