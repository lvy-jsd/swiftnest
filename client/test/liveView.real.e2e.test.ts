/** Real labwc → Rust Perch → encrypted Nest/App relay → browser LivePanel.
 * Only owner-session admission is a fixture (the signed DSH login has separate e2es).
 */
import type { Browser } from '@playwright/test';
import { launchChromium } from './browser';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startScreenFixture } from './fixtures/screenHost.js';

it
  .skipIf(process.env.SWIFTNEST_WEB_E2E !== '1' || process.env.SWIFTNEST_SCREEN_E2E !== '1')
  .each(['en', 'zh-CN'] as const)(
  'live panel: %s 390px real labwc frame screenshots in Ivy and owner control',
  async (locale) => {
    const zh = locale === 'zh-CN';
    const host = await startScreenFixture();
    let browser: Browser | undefined;
    let server: ViteDevServer | undefined;
    try {
      host.send({ op: 'start', settings: { ...host.last().settings, allowLiveView: true } });
      await expect.poll(() => host.last()?.settings.allowLiveView && host.last()?.phase === 'online').toBe(true);
      const device = host.hub.nest.devices()[0]!.device;
      const fixture = `
        import React from 'react';import{createRoot}from'react-dom/client';
        import{LiveView}from'/@fs/${resolve('packages/api/src/live.ts')}';
        import{LivePanel}from'/src/liveView.tsx';import{ThemeProvider}from'/src/design/theme.tsx';
        import{I18nProvider}from'/src/i18n.tsx';import{ConnectionProvider,ConnectionStore}from'/src/connection.tsx';import'/src/styles.css';
        const store=new ConnectionStore();
        store.client={close(){},async openLiveView(device,options){
          const response=await fetch('/swiftnest/api/devices/live?'+new URLSearchParams({device,maxDimension:String(options.maxDimension)}),{method:'POST',signal:options.signal});
          if(!response.ok)throw new Error('Live offer HTTP '+response.status);
          const offer=await response.json();const url=new URL('/swiftnest/api/devices/live?id='+offer.id,location.href);url.protocol='ws:';
          const socket=new WebSocket(url);socket.binaryType='arraybuffer';return LiveView.open(socket,offer);
        }};
        const root=createRoot(document.getElementById('root'));
        root.render(React.createElement(ThemeProvider,null,React.createElement(I18nProvider,{initialLocale:'${locale}'},React.createElement(ConnectionProvider,{store},React.createElement(LivePanel,{device:{device:${JSON.stringify(device)},name:'Headless labwc'},onClose:()=>root.unmount()})))));
      `;
      server = await createServer({
        root: resolve('client'),
        cacheDir: resolve(host.home, 'vite-cache'),
        server: {
          host: '127.0.0.1',
          port: 0,
          proxy: {
            '/swiftnest/api/devices': {
              target: host.appUrl,
              ws: true,
              headers: { authorization: 'Bearer owner-session' },
            },
          },
        },
        plugins: [
          {
            name: 'real-live-fixture',
            configureServer(s) {
              s.middlewares.use('/__real_live', async (_req, res) => {
                res.setHeader('content-type', 'text/html');
                res.end(
                  await s.transformIndexHtml(
                    '/__real_live',
                    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/__x00__real-live-fixture"></script></body></html>',
                  ),
                );
              });
            },
            resolveId(id) {
              if (id === '\0real-live-fixture') return id;
            },
            load(id) {
              if (id === '\0real-live-fixture') return fixture;
            },
          },
        ],
      });
      await server.listen();
      browser = await launchChromium();
      const page = await browser.newPage({
        locale,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => localStorage.setItem('swiftnest.locale', lang), locale);
      await page.goto(`${server.resolvedUrls!.local[0]!}__real_live`);
      const panel = page.getByRole('dialog');
      const image = panel.getByRole('img');
      await image.waitFor({ timeout: 20000 });
      await expect
        .poll(() =>
          image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 640 && img.naturalHeight > 0),
        )
        .toBe(true);
      // Check the real fixture's red wl_shm pixels after capture/JPEG/decryption/decode.
      // Canvas is only used to inspect the received image, never to manufacture a frame.
      const pixel = await image.evaluate((img: HTMLImageElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(10, 10, 1, 1).data];
      });
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(50);
      expect(pixel[2]).toBeLessThan(50);
      expect((await panel.boundingBox())!.width).toBe(390);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await panel.getByText(zh ? '小艾正在控制' : 'Ivy is in control', { exact: true }).waitFor();
      const screenshots = host.home;
      await page.screenshot({ path: resolve(screenshots, `live-view-${locale}-390-ivy.png`), animations: 'disabled' });
      await panel.getByRole('button', { name: zh ? '接管控制' : 'Take over', exact: true }).click();
      await panel.getByText(zh ? '你正在控制' : 'You are in control', { exact: true }).waitFor();
      await expect.poll(() => host.last()?.ownerControl).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `live-view-${locale}-390-owner.png`),
        animations: 'disabled',
      });
      const rect = (await image.boundingBox())!;
      await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await expect.poll(() => host.clicks.length).toBe(1);
      await panel.getByRole('button', { name: zh ? '交还控制' : 'Hand back', exact: true }).click();
      await panel.getByText(zh ? '小艾正在控制' : 'Ivy is in control', { exact: true }).waitFor();
      await expect.poll(() => host.last()?.ownerControl).toBe(false);
      await panel.getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click();
      await expect.poll(() => host.last()?.watching, { timeout: 10000 }).toBe(false);
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}\n${host.errors.slice(-15).join('\n')}`, { cause: error });
    } finally {
      await browser?.close();
      await server?.close();
      await host.close();
    }
  },
  60000,
);
