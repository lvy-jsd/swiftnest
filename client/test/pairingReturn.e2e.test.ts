import { resolve } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { launchChromium } from './browser';

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'pairing return is determined by the launch link, not restore/render ordering',
  async () => {
    const server = await createServer({
      root: resolve('client'),
      cacheDir: resolve('node_modules/.cache/swiftnest/pairing-return-fixture'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'pairing-return-fixture',
          configureServer(s) {
            s.middlewares.use('/__pairing_return', async (_req, res) => {
              res.setHeader('content-type', 'text/html');
              res.end(
                await s.transformIndexHtml(
                  '/__pairing_return',
                  '<html><body><div id="root"></div><script type="module" src="/test/fixtures/pairing-return-page.tsx"></script></body></html>',
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
      for (const order of ['before', 'after']) {
        for (const destination of ['', 'plugins', 'models']) {
          const page = await browser.newPage();
          try {
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const pairing = new URLSearchParams({ url: `${server.resolvedUrls!.local[0]}connect?token=test` });
            if (destination) pairing.set('return', destination);
            await page.goto(`${server.resolvedUrls!.local[0]}__pairing_return?restore=${order}#/pair?${pairing}`);
            // The barrier proves PairPage mounted during restore, before pairing succeeds.
            await expect.poll(() => page.evaluate(() => (window as any).pairingTest?.calls())).toBe(1);
            expect(await page.evaluate(() => (window as any).pairingTest.snapshot().pluginRestart)).toBe(
              'reconnecting',
            );
            await page.evaluate(() => (window as any).pairingTest.release());
            await expect.poll(() => new URL(page.url()).hash).toBe(`#/${destination}`);
            expect(new URL(page.url()).href).not.toContain('token=');
            expect(errors).toEqual([]);
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
  90_000,
);
