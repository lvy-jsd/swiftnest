import { createServer } from 'vite';
import { launchChromium } from './browser';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'Transfers: phone width, en/zh, progress, pause/resume/cancel/retry and send form',
  async () => {
    const fixture = `
    import React from 'react';import{createRoot}from'react-dom/client';import{TransfersPage}from'/src/transfers.tsx';import{DeviceHubProvider}from'/src/devices.tsx';import{ConnectionProvider,ConnectionStore}from'/src/connection.tsx';import{I18nProvider}from'/src/i18n.tsx';import{ThemeProvider}from'/src/design/theme.tsx';import'/src/styles.css';
    let notify;const calls=window.calls=[];let rows=[{id:'a'.repeat(64),name:'Very long video filename with spaces 视频.mp4',source:{device:'computer',path:'video.mp4'},destination:{device:'phone',path:'video.mp4'},size:10737418240,offset:5368709120,state:'running',route:'direct',speed:10485760,eta:512,updatedAt:Date.now()}];
    const client={connect:async()=>{},listSessions:async()=>[],listDevices:async()=>[{device:'computer',slug:'computer',name:'Computer',paired:true,online:true,capabilities:[]},{device:'phone',slug:'phone',name:'Phone',paired:true,online:true,capabilities:[]}],listDeviceApprovals:async()=>[],listDevicePairings:async()=>[],listTransfers:async()=>structuredClone(rows),watchDevices:async()=>({async *[Symbol.asyncIterator](){while(true){await new Promise(r=>notify=r);yield {type:'transfers-changed'};}}}),transferAction:async(id,action)=>{calls.push(action);rows[0].state=action==='pause'?'paused':action==='cancel'?'cancelled':'running';},startTransfer:async(request)=>{calls.push(request);},close(){}};
    window.fail=()=>{rows[0].state='failed';notify?.();};const store=new ConnectionStore(async()=>({cookieMode:'browser'}),()=>client);await store.pair(location.origin+'/connect?token=test');
    const locale=new URL(location.href).searchParams.get('lang')||'en';createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,React.createElement(I18nProvider,{initialLocale:locale},React.createElement(ConnectionProvider,{store},React.createElement(DeviceHubProvider,null,React.createElement(TransfersPage,{onBack(){}}))))));
  `;
    const server = await createServer({
      root: resolve('client'),
      cacheDir: resolve('node_modules/.cache/swiftnest/transfer-fixture'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'transfers-fixture',
          configureServer(s) {
            s.middlewares.use('/__transfer_test', async (_req, res) => {
              res.setHeader('content-type', 'text/html');
              res.end(
                await s.transformIndexHtml(
                  '/__transfer_test',
                  '<html><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/@id/__x00__transfers-fixture"></script></body></html>',
                ),
              );
            });
          },
          resolveId(id) {
            if (id === '\0transfers-fixture') return id;
          },
          load(id) {
            if (id === '\0transfers-fixture') return fixture;
          },
        },
      ],
    });
    await server.listen();
    const browser = await launchChromium();
    try {
      for (const lang of ['en', 'zh-CN']) {
        const page = await browser.newPage({
          locale: lang,
          viewport: { width: 390, height: 844 },
        });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${server.resolvedUrls!.local[0]}__transfer_test?lang=${lang}`);
        const zh = lang === 'zh-CN';
        const card = page.locator('.transfer-card');
        await card.waitFor();
        expect(await page.getByRole('progressbar').getAttribute('value')).toBe('5368709120');
        await page.getByText('5.00 GiB / 10.00 GiB', { exact: false }).waitFor();
        await page.getByRole('button', { name: zh ? '暂停' : 'Pause', exact: true }).click();
        await page.getByRole('button', { name: zh ? '继续' : 'Resume', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).calls)).toEqual(['pause', 'resume']);
        await page.evaluate(() => (window as any).fail());
        await page.getByRole('button', { name: zh ? '重试' : 'Retry', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1))).toBe('retry');
        await page
          .getByRole('button', {
            name: zh ? '发送文件到…' : 'Send file to…',
            exact: true,
          })
          .click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        const inputs = dialog.getByRole('textbox');
        await inputs.nth(0).fill('archive.zip');
        await inputs.nth(1).fill('/Shared/archive.zip');
        await dialog
          .getByRole('button', {
            name: zh ? '开始传输' : 'Start transfer',
            exact: true,
          })
          .click();
        await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1)?.source?.path)).toBe('archive.zip');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await page.screenshot({
          path: resolve(`client/test/screenshots/transfers-${lang}-390.png`),
          fullPage: true,
        });
        await page.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1))).toBe('cancel');
        await page.close();
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
  60000,
);
