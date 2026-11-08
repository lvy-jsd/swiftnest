import { createServer } from 'vite';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { launchChromium } from './browser';

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'chat media: previews, download, speech notice and existing phone transfer form in en/zh',
  async () => {
    const server = await mediaPage();
    const browser = await launchChromium();
    try {
      for (const lang of ['en', 'zh-CN']) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${server.resolvedUrls!.local[0]}__media_test?lang=${lang}`);
        const zh = lang === 'zh-CN';
        await page
          .getByRole('status')
          .filter({ hasText: zh ? '首次' : 'first use' })
          .waitFor();
        expect(await page.getByRole('status').textContent()).toContain('200 MB');
        const photo = page.getByRole('img', { name: 'sent.png', exact: true });
        await expect.poll(() => photo.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
        expect(await photo.getAttribute('class')).toBe('message-photo');
        await page.getByText(zh ? '图片无法显示' : 'Photo unavailable', { exact: true }).waitFor();
        expect(await page.locator('.media-attachment img').count()).toBe(2);
        await page.getByRole('img', { name: 'animation.gif', exact: true }).waitFor();
        expect(await page.locator('.media-attachment video[controls]').count()).toBe(1);
        expect(await page.locator('.media-attachment audio[controls]').count()).toBe(1);
        await expect.poll(() => page.getByRole('link', { name: zh ? '下载文件' : 'Download file' }).count()).toBe(5);
        const requests = await page.evaluate(() => (window as any).requests);
        expect(requests.filter((request: unknown) => request === 'media/chart.png')).toHaveLength(1);
        // DSH 0.2.2 verifies every field, so the App sends the whole reference.
        expect(requests).toContainEqual({
          sessionId: 'photos',
          attachment: {
            attachmentId: 'stored',
            mediaType: 'image/png',
            bytes: 68,
            width: 1,
            height: 1,
            name: 'sent.png',
          },
        });
        await checkAttachmentTheme(page);
        await page.locator('.media-attachment').first().getByRole('button').click();
        const dialog = page.getByRole('dialog');
        const fields = dialog.getByRole('textbox');
        expect(await fields.first().inputValue()).toBe('media/chart.png');
        await fields.last().fill('/shared/chart.png');
        await dialog.getByRole('button', { name: zh ? '开始传输' : 'Start transfer', exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => (window as any).requests.at(-1)))
          .toEqual({
            source: { device: 'server', path: 'media/chart.png' },
            destination: { device: 'phone', path: '/shared/chart.png' },
          });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
  60_000,
);
async function checkAttachmentTheme(page: Page) {
  const card = page.locator('.media-attachment').first();
  expect(await card.getAttribute('class')).toContain('card');
  expect(
    await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return { gap: style.gap, padding: style.padding, radius: style.borderRadius };
    }),
  ).toEqual({ gap: '12px', padding: '16px', radius: '20px' });
  expect(await card.locator('img').evaluate((element) => getComputedStyle(element).maxHeight)).toBe('384px');
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(colorScheme);
    expect(await card.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  }
}
async function mediaPage() {
  const server = await createServer({
    root: resolve('client'),
    cacheDir: resolve('node_modules/.cache/swiftnest/media-fixture'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'media-fixture',
        configureServer(s) {
          s.middlewares.use('/__media_test', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await s.transformIndexHtml(
                '/__media_test',
                '<html><body><div id="root"></div><script type="module" src="/test/fixtures/media-page.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  return server;
}
