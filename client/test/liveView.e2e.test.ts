/** UI gestures tested with a deterministic native-stream fixture; the real crypto/host path has its own e2e. */
import { createServer } from 'vite';
import { launchChromium } from './browser';
import { expect, it, onTestFinished } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'live panel: phone/desktop, en/zh, tap, hold, drag, keyboard, control state and cleanup',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-live-browser-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const fixture = `
    import React from 'react';import{createRoot}from'react-dom/client';
    import{LivePanel}from'/src/liveView.tsx';import{ThemeProvider}from'/src/design/theme.tsx';import{I18nProvider}from'/src/i18n.tsx';import{ConnectionProvider,ConnectionStore}from'/src/connection.tsx';import'/src/styles.css';
    const calls=window.calls=[];const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#724fab';ctx.fillRect(0,0,640,360);
    const frame={captureId:'frame',displayId:'display',width:640,height:360,scaleFactor:0.5,mime:'image/jpeg',image:Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]),c=>c.charCodeAt(0))};
    class Live {q=[{control:'ivy',frame}];closed=false;push(v){this.q.push(v);this.wake?.();}async *[Symbol.asyncIterator](){while(!this.closed){if(!this.q.length)await new Promise(r=>this.wake=r);while(this.q.length)yield this.q.shift();}}async takeOver(){calls.push('take');this.push({control:'owner'});}async handBack(){calls.push('back');this.push({control:'ivy'});}async input(tool,args){calls.push({tool,args});}close(){calls.push('close');this.closed=true;this.wake?.();}}
    const store=new ConnectionStore();store.client={openLiveView:async()=>new Live(),close(){}};
    const locale=new URL(location.href).searchParams.get('lang')||'en';
    const appRoot=createRoot(document.getElementById('root'));appRoot.render(React.createElement(ThemeProvider,null,React.createElement(I18nProvider,{initialLocale:locale},React.createElement(ConnectionProvider,{store},React.createElement(LivePanel,{device:{device:'test',name:'Laptop'},onClose:()=>{calls.push('dismiss');appRoot.unmount();}})))));
  `;
    const server = await createServer({
      root: resolve('client'),
      cacheDir: join(home, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'live-fixture',
          configureServer(s) {
            s.middlewares.use('/__live_test', async (_req, res) => {
              res.setHeader('content-type', 'text/html');
              res.end(
                await s.transformIndexHtml(
                  '/__live_test',
                  '<html><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/@id/__x00__live-fixture"></script></body></html>',
                ),
              );
            });
          },
          resolveId(id) {
            if (id === '\0live-fixture') return id;
          },
          load(id) {
            if (id === '\0live-fixture') return fixture;
          },
        },
      ],
    });
    await server.listen();
    const url = server.resolvedUrls!.local[0]!;
    const browser = await launchChromium();
    try {
      for (const [width, lang] of [
        [390, 'en'],
        [390, 'zh-CN'],
        [1280, 'en'],
      ] as const) {
        const page = await browser.newPage({ locale: lang, viewport: { width, height: 844 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${url}__live_test?lang=${lang}`);
        const zh = lang === 'zh-CN';
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await dialog.getByRole('img').waitFor();
        await dialog.getByRole('button', { name: zh ? '接管控制' : 'Take over', exact: true }).click();
        await dialog.getByText(zh ? '你正在控制' : 'You are in control', { exact: true }).waitFor();
        const rect = (await dialog.getByRole('img').boundingBox())!;
        const x = rect.x + rect.width / 2,
          y = rect.y + rect.height / 2;
        await page.mouse.click(x, y);
        await expect
          .poll(() => page.evaluate(() => (window as any).calls.filter((c: any) => c.tool === 'input_click').length))
          .toBe(1);
        const args = await page.evaluate(() => (window as any).calls.find((c: any) => c.tool === 'input_click').args);
        expect(args.x).toBeCloseTo(320, 0);
        expect(args.y).toBeCloseTo(180, 0);
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(550);
        await page.mouse.up();
        await expect
          .poll(() =>
            page.evaluate(() => (window as any).calls.filter((c: any) => c.tool === 'input_click').at(-1)?.args.button),
          )
          .toBe('right');
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 20, y + 20);
        await page.mouse.up();
        expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.tool === 'input_drag'))).toBe(true);
        await page.locator('.live-surface').evaluate((element) => {
          const event = (type: string, id: number, x: number, y: number) =>
            element.dispatchEvent(
              new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch' }),
            );
          // Synthetic pointer capture has no active OS pointer, so substitute only capture for this gesture.
          element.setPointerCapture = () => {};
          event('pointerdown', 100, 100, 300);
          event('pointerdown', 101, 200, 300);
          event('pointermove', 100, 100, 320);
          event('pointermove', 101, 200, 320);
        });
        await expect
          .poll(() => page.evaluate(() => (window as any).calls.some((c: any) => c.tool === 'input_scroll')))
          .toBe(true);
        await page.locator('.live-surface').evaluate((element) => {
          for (const [id, x] of [
            [100, 80],
            [101, 220],
          ])
            element.dispatchEvent(
              new PointerEvent('pointermove', {
                pointerId: id,
                clientX: x,
                clientY: 320,
                bubbles: true,
                pointerType: 'touch',
              }),
            );
        });
        await expect
          .poll(() => dialog.getByRole('img').evaluate((element) => element.style.transform))
          .toContain('scale(1.4)');
        await page.locator('.live-surface').evaluate((element) => {
          for (const id of [100, 101])
            element.dispatchEvent(
              new PointerEvent('pointerup', { pointerId: id, bubbles: true, pointerType: 'touch' }),
            );
        });
        await dialog.getByRole('button', { name: zh ? '键盘' : 'Keyboard', exact: true }).click();
        await dialog.getByRole('textbox').fill('你好');
        await dialog.getByRole('button', { name: zh ? '发送消息' : 'Send message', exact: true }).click();
        expect(
          await page.evaluate(() =>
            (window as any).calls.some((c: any) => c.tool === 'input_type' && c.args.text === '你好'),
          ),
        ).toBe(true);
        await dialog.getByRole('button', { name: zh ? '交还控制' : 'Hand back', exact: true }).click();
        await dialog.getByText(zh ? '小艾正在控制' : 'Ivy is in control', { exact: true }).waitFor();
        const box = (await dialog.boundingBox())!;
        expect(box.width).toBeLessThanOrEqual(width);
        if (width === 390) expect(box.width).toBe(390);
        else expect(box.x).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await dialog.getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).calls.includes('close'))).toBe(true);
        await page.close();
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
  60000,
);
