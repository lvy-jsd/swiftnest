/** Real App/owner session; tool HTTP views are fixtures so no external MCP service starts. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { ToolsView } from '@swiftnest/api';
import { expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';
import { startKernel } from '../../server/src/kernel';
import { webAppUrl } from '../../server/src/pairing';
import { launchChromium } from './browser';
import { openSettingsPage } from './navigation';
import { translate } from '../src/i18n';

async function stubTools(page: Page) {
  let applies = 0;
  let view: ToolsView = {
    presets: [
      {
        id: 'fixture',
        title: 'Fixture service',
        summary: 'A tool service with an optional access key.',
        category: 'test',
        source: '@fixture/tool-service',
        license: 'MIT',
        enabled: false,
        state: 'off',
        needs: [{ env: 'FIXTURE_KEY', hint: 'Get a key at https://example.test/keys' }],
      },
    ],
    packs: [],
    pending: false,
    apply: { state: 'idle' },
  };
  await page.route('**/swiftnest/api/tools**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      view = { ...view, pending: true };
      if (path.endsWith('/enable') || path.endsWith('/disable')) {
        const enabled = path.endsWith('/enable');
        view = { ...view, presets: view.presets.map((p) => ({ ...p, enabled, state: enabled ? 'needs-key' : 'off' })) };
      } else if (path.endsWith('/apply')) {
        ++applies;
        view = { ...view, pending: false };
      } else if (path.endsWith('/delete')) {
        view = { ...view, packs: [] };
      } else {
        view = { ...view, packs: [{ name: path.split('/').at(-1)!, targets: route.request().postDataJSON().targets }] };
      }
    }
    await route.fulfill({ json: view });
  });
  // Leave the existing plugin page settled, so only the tool ApplyPanel is pending.
  await page.route('**/swiftnest/api/plugins**', (route) =>
    route.fulfill({ json: { plugins: [], unaudited: [], pending: false, apply: { state: 'idle' } } }),
  );
  return () => applies;
}

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'tool controls: switch, missing-key hint, bundle save/delete and apply; phone/desktop, light/dark, en/zh',
  async () => {
    const browser = await launchChromium();
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-tools-browser-'));
    const shots = process.env.SWIFTNEST_TOOLS_SHOTS ?? join(home, 'shots');
    await mkdir(shots, { recursive: true });
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
          SWIFTNEST_PLUGINS: 'tool-ultra=false',
          SWIFTNEST_APP_DIST:
            process.env.SWIFTNEST_TOOLS_APP_DIST ?? fileURLToPath(new URL('../dist/', import.meta.url)),
        }),
        { readyTimeoutMs: 90000, onLine: (line) => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')) },
      );
      for (const locale of ['en', 'zh-CN'] as const)
        for (const colorScheme of ['light', 'dark'] as const)
          for (const width of [390, 1440]) {
            const context = await browser.newContext({
              viewport: { width, height: width === 390 ? 844 : 900 },
              colorScheme,
            });
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const applies = await stubTools(page);
            await page.route('**/swiftnest/api/devices/preferences', (route) =>
              route.fulfill({ json: { lang: locale } }),
            );
            await page.addInitScript((lang) => localStorage.setItem('swiftnest.locale', lang), locale);
            await page.goto(webAppUrl(kernel.url, kernel.token));
            await openSettingsPage(page, 'shell.plugins', locale);
            const section = page.locator('.tools-section');
            const control = section.getByRole('switch', { name: 'Fixture service' });
            await control.waitFor();
            expect(await control.isChecked()).toBe(false);
            await control.click();
            await expect.poll(() => control.isChecked()).toBe(true);
            await section.getByText('FIXTURE_KEY', { exact: true }).waitFor();
            expect(await section.textContent()).toContain('https://example.test/keys');
            const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
            await section.getByLabel(t('toolsPackName'), { exact: true }).fill('research');
            await section.getByLabel(t('toolsPackTargets'), { exact: true }).fill('pack:web\npack:media');
            await section.getByRole('button', { name: t('toolsAddPack'), exact: true }).click();
            await section.getByText('pack:web, pack:media', { exact: true }).waitFor();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            for (const element of await section.locator('button, input, textarea').all()) {
              const box = await element.boundingBox();
              expect(box!.width).toBeGreaterThanOrEqual(44);
              expect(box!.height).toBeGreaterThanOrEqual(44);
            }
            await page.screenshot({
              path: join(shots, `tools-bundles-${locale}-${colorScheme}-${width}.png`),
              fullPage: true,
            });
            await section.locator('#tools-title').scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(shots, `tools-${locale}-${colorScheme}-${width}.png`), fullPage: true });
            await section
              .getByRole('button', { name: t('toolsDeletePack').replace('{name}', 'research'), exact: true })
              .click();
            await section.getByText(t('toolsPacksEmpty'), { exact: true }).waitFor();
            await section.getByRole('button', { name: t('pluginsApply'), exact: true }).click();
            await expect.poll(applies).toBe(1);
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
  180000,
);
