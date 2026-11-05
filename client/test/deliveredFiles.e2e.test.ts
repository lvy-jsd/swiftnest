import { resolve } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { launchChromium } from './browser';
import { translate } from '../src/i18n';

/** Reuse the existing attachment fixture so download/transfer behavior is tested unchanged. */
async function attachmentPage() {
  const server = await createServer({
    root: resolve('client'),
    cacheDir: resolve('node_modules/.cache/swiftnest/b1-files-fixture'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'b1-files-fixture',
        configureServer(vite) {
          vite.middlewares.use('/__b1_files', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__b1_files',
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

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'delivered files expose filenames, real counts, thin icons and a view action alongside download and transfer',
  async () => {
    const server = await attachmentPage();
    const browser = await launchChromium();
    try {
      for (const locale of ['zh-CN', 'en'] as const) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await page.goto(`${server.resolvedUrls!.local[0]}__b1_files?lang=${locale}`);
        const cards = page.locator('.media-attachment');
        await expect
          .poll(() => cards.getByRole('link', { name: translate(locale, 'chat.viewFile'), exact: true }).count())
          .toBe(5);
        expect(await cards.count()).toBe(5);
        const first = cards.first();
        expect(await first.locator('strong').textContent()).toBe('chart.png');
        expect(await first.locator('.delivered-file__copy p').textContent()).toBe(
          translate(locale, 'chat.deliveredFiles').replace('{count}', '5'),
        );
        const view = first.getByRole('link', { name: translate(locale, 'chat.viewFile'), exact: true });
        expect(await view.getAttribute('href')).toMatch(/^blob:/);
        expect(await view.getAttribute('target')).toBe('_blank');
        const box = await view.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(await first.locator('.delivered-file svg').getAttribute('viewBox')).toBe('0 0 24 24');
        expect(await first.locator('.delivered-file svg').getAttribute('stroke-width')).toBe('1.7');
        expect(await first.getByRole('link', { name: translate(locale, 'media.download'), exact: true }).count()).toBe(
          1,
        );
        await page.close();
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
