/** Real App + authenticated kernel; only plugin HTTP state and restart downtime are stubbed. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { Page, WebSocketRoute } from '@playwright/test';
import type { PluginsView } from '@swiftnest/api';
import { loadConfig } from '../../server/src/config';
import { startKernel } from '../../server/src/kernel';
import { webAppUrl } from '../../server/src/pairing';
import { launchChromium } from './browser';
import { translate, type Locale } from '../src/i18n';

function fixtureView(locale: Locale): PluginsView {
  const zh = locale === 'zh-CN';
  const base = { active: false, enabled: false, recommended: false, locked: false, license: 'MIT' };
  return {
    plugins: [
      {
        ...base,
        id: 'vision-router',
        title: zh ? '看懂图片' : 'Understand images',
        summary: zh ? '帮助助手理解图片内容' : 'Help your assistant understand images',
        note: zh ? '图片会发送给你选择的云服务。' : 'Images are sent to your chosen cloud service.',
      },
      {
        ...base,
        id: 'safe',
        title: zh ? '安全保护' : 'Safety protection',
        summary: zh ? '拦住危险操作' : 'Block dangerous actions',
        recommended: true,
        active: true,
        enabled: true,
        locked: true,
      },
      {
        ...base,
        id: 'market',
        title: zh ? '社区插件市场' : 'Community market',
        summary: zh ? '发现更多插件' : 'Discover more plugins',
        note: zh ? '请先了解风险。' : 'Read the risks first.',
      },
    ],
    unaudited: ['community-example'],
    pending: false,
    apply: { state: 'idle' },
  };
}
async function stubPlugins(page: Page, locale: Locale) {
  let view = fixtureView(locale);
  let offlineUntil = 0;
  let connections = 0;
  let denied = false;
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket('**/api/remote.mux', (socket) => {
    ++connections;
    if (Date.now() < offlineUntil) {
      socket.close({ code: 1012 });
      return;
    }
    sockets.add(socket);
    socket.connectToServer();
  });
  await page.route('**/swiftnest/api/devices/preferences', (route) => route.fulfill({ json: { lang: locale } }));
  await page.route('**/swiftnest/api/plugins**', async (route) => {
    if (denied) {
      await route.fulfill({ status: 403 });
      return;
    }
    if (Date.now() < offlineUntil) {
      await route.fulfill({ status: 503 });
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/enable') || path.endsWith('/disable')) {
      const id = path.split('/').at(-2);
      view = {
        ...view,
        pending: true,
        plugins: view.plugins.map((p) => (p.id === id ? { ...p, enabled: path.endsWith('/enable') } : p)),
      };
    }
    if (path.endsWith('/apply')) {
      view = { ...view, apply: { state: 'installing' } };
      await route.fulfill({ status: 202, json: view });
      setTimeout(() => {
        view = { ...view, apply: { state: 'restarting' } };
        offlineUntil = Date.now() + 1200;
        for (const socket of sockets) socket.close({ code: 1012 });
        sockets.clear();
        setTimeout(() => {
          view = {
            ...view,
            pending: false,
            apply: { state: 'idle' },
            plugins: view.plugins.map((p) => ({ ...p, active: p.enabled })),
          };
        }, 1200);
      }, 500);
      return;
    }
    await route.fulfill({ json: view });
  });
  return {
    connections: () => connections,
    deny: () => {
      denied = true;
    },
  };
}
async function exercisePlugins(page: Page, locale: Locale, url: string, screenshotPath: string) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const mock = await stubPlugins(page, locale);
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.error('browser:', message.text().replace(/token=[^&\s]+/g, 'token=REDACTED'));
  });
  await page.addInitScript((lang) => localStorage.setItem('swiftnest.locale', lang), locale);
  await page.goto(url);
  await page
    .getByRole('link', { name: t('pluginsTitle'), exact: true })
    .last()
    .click();
  const pluginSwitch = page.getByRole('switch', { name: locale === 'en' ? 'Understand images' : '看懂图片' });
  const cards = page.locator('main .plugin-card');
  expect(await cards.first().textContent()).toContain(locale === 'en' ? 'Safety protection' : '安全保护');
  expect(await page.getByRole('switch').first().isDisabled()).toBe(true);
  await page.getByText(t('pluginsNotReviewed'), { exact: true }).waitFor();
  await pluginSwitch.click();
  const sheet = page.getByRole('dialog');
  await sheet
    .getByText(locale === 'en' ? 'Images are sent to your chosen cloud service.' : '图片会发送给你选择的云服务。')
    .waitFor();
  expect(await pluginSwitch.isChecked()).toBe(false);
  await sheet.getByRole('button', { name: t('pluginsCancel'), exact: true }).click();
  expect(await pluginSwitch.isChecked()).toBe(false);
  await pluginSwitch.click();
  await sheet.getByRole('button', { name: t('pluginsEnable'), exact: true }).click();
  await expect.poll(() => pluginSwitch.isChecked()).toBe(true);
  if (locale === 'zh-CN') await page.screenshot({ path: screenshotPath, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: t('pluginsApply'), exact: true }).click();
  await page.getByText(t('pluginsPreparing'), { exact: true }).waitFor();
  await page.getByText(t('pluginsRestarting'), { exact: true }).waitFor();
  await expect.poll(() => page.getByText(t('pluginsRestarting'), { exact: true }).count(), { timeout: 15000 }).toBe(0);
  expect(await pluginSwitch.isChecked()).toBe(true);
  expect(page.url()).toContain('#/plugins');
  expect(mock.connections()).toBeGreaterThan(2);
  expect(await page.getByRole('button', { name: t('pluginsApply'), exact: true }).count()).toBe(0);
  await page.getByRole('switch', { name: locale === 'en' ? 'Community market' : '社区插件市场' }).click();
  await sheet.getByText(t('pluginsMarketWarning'), { exact: true }).waitFor();
  await sheet.getByRole('button', { name: t('pluginsCancel'), exact: true }).click();
  mock.deny();
  await expect.poll(() => page.getByRole('link', { name: t('pluginsTitle'), exact: true }).count()).toBe(0);
  await page.getByText(t('pluginsOwnerOnly'), { exact: true }).waitFor();
}
it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'recommended plugins: en + zh at 390px, note → apply → restart → recovery; owner only',
  async () => {
    const browser = await launchChromium();
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-plugins-browser-'));
    const logs: string[] = [];
    let kernel: Awaited<ReturnType<typeof startKernel>> | undefined;
    try {
      kernel = await startKernel(
        loadConfig(undefined, {
          SWIFTNEST_HOME: home,
          SWIFTNEST_LANG: 'en',
          SWIFTNEST_DEVICES_PORT: '0',
          SWIFTNEST_DEVICES_MDNS: 'false',
          SWIFTNEST_HOST: '127.0.0.1',
          SWIFTNEST_PORT: '0',
          SWIFTNEST_APP_DIST: fileURLToPath(new URL('../dist/', import.meta.url)),
        }),
        { readyTimeoutMs: 90000, onLine: (line) => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')) },
      );
      for (const locale of ['en', 'zh-CN'] as const) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await exercisePlugins(page, locale, webAppUrl(kernel.url, kernel.token), join(home, 'P1-zh.png'));
        expect(errors).toEqual([]);
        await context.close();
      }
    } catch (error) {
      throw new Error(`${String(error)}\n${logs.slice(-20).join('\n')}`, { cause: error });
    } finally {
      await browser.close();
      await kernel?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
  120000,
);
