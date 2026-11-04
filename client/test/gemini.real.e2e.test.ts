/** Real Models API and apply/reconnect flow; fake key, no Google requests. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import type { ModelsView } from '@swiftnest/api';
import { loadConfig } from '../../server/src/config';
import { startKernel } from '../../server/src/kernel';
import { webAppUrl } from '../../server/src/pairing';
import { translate, type Locale } from '../src/i18n';
import { launchChromium } from './browser';

const KEY = 'google-fake-browser-key-wxyz';
const enabled = process.env.SWIFTNEST_E2E === '1' && process.env.SWIFTNEST_WEB_E2E === '1';
const view = (page: Page): Promise<ModelsView> =>
  page.evaluate(async () => (await fetch('/swiftnest/api/models')).json());

async function start(home: string, locale: Locale) {
  const config = loadConfig(undefined, {
    SWIFTNEST_HOME: home,
    SWIFTNEST_LANG: locale,
    SWIFTNEST_HOST: '127.0.0.1',
    SWIFTNEST_PORT: '0',
    SWIFTNEST_DEVICES_PORT: '0',
    SWIFTNEST_DEVICES_MDNS: 'false',
    SWIFTNEST_PLUGINS: 'tool-ultra=false',
    SWIFTNEST_APP_DIST: fileURLToPath(new URL('../dist/', import.meta.url)),
    SWIFTNEST_MODEL_ID: 'fake',
    SWIFTNEST_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
  });
  let boots = 0;
  const logs: string[] = [];
  const kernel = await startKernel(config, {
    readyTimeoutMs: 30_000,
    onReady(running) {
      config.port = Number(new URL(running.url).port);
      ++boots;
    },
    onLine: (line) => logs.push(line),
  });
  return { kernel, logs, boots: () => boots };
}

async function addGoogleKey(page: Page, locale: Locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const toggle = page.getByRole('switch', { name: t('media.gemini_uploads_switch') });
  expect(await toggle.isChecked()).toBe(false);
  await toggle.click();
  const sheet = page.getByRole('dialog');
  await sheet.getByText(t('media.gemini_uploads_key_required'), { exact: true }).waitFor();
  expect(await sheet.getByRole('link', { name: t('modelsGetKey') }).getAttribute('href')).toBe(
    'https://aistudio.google.com/apikey',
  );
  expect((await view(page)).geminiUploads).toBe(false);
  expect(await sheet.getByRole('button', { name: t('modelsSave'), exact: true }).isDisabled()).toBe(true);
  await sheet.getByLabel(t('modelsKey'), { exact: true }).fill(KEY);
  await sheet.getByRole('button', { name: t('modelsSave'), exact: true }).click();
  await expect
    .poll(async () => (await view(page)).providers.find((provider) => provider.id === 'google')?.keyHint)
    .toBe('wxyz');
  await sheet.waitFor({ state: 'hidden' });
  expect((await view(page)).expert).toBeUndefined();
  await expect.poll(() => toggle.isChecked()).toBe(false);
}

async function toggleAndApply(page: Page, locale: Locale, boots: () => number) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const toggle = page.getByRole('switch', { name: t('media.gemini_uploads_switch') });
  await toggle.click();
  await expect.poll(async () => (await view(page)).geminiUploads).toBe(true);
  expect((await view(page)).pending).toBe(true);
  await page.reload();
  await expect.poll(() => toggle.isChecked()).toBe(true);
  const count = boots();
  await page.getByRole('button', { name: t('pluginsApply'), exact: true }).click();
  await expect.poll(boots, { timeout: 30_000 }).toBe(count + 1);
  await expect.poll(() => toggle.isEnabled(), { timeout: 20_000 }).toBe(true);
  expect(await view(page)).toMatchObject({ geminiUploads: true, pending: false });
  await toggle.click();
  await expect.poll(async () => (await view(page)).geminiUploads).toBe(false);
  await toggle.click();
  await expect.poll(async () => (await view(page)).geminiUploads).toBe(true);
  await page.getByRole('button', { name: t('modelsKeyRemove'), exact: true }).click();
  await expect.poll(async () => (await view(page)).geminiUploads).toBe(false);
  await expect.poll(() => toggle.isChecked()).toBe(false);
}

it.skipIf(!enabled).each(['en', 'zh-CN'] as const)(
  'Gemini uploads: guided key setup, persistence and apply at 390 px in %s',
  async (locale) => {
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-gemini-ui-'));
    const running = await start(home, locale);
    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => localStorage.setItem('swiftnest.locale', lang), locale);
      await page.goto(webAppUrl(running.kernel.url, running.kernel.token));
      await page
        .getByRole('main')
        .getByRole('link', { name: translate(locale, 'modelsTitle'), exact: true })
        .click();
      await page.getByText(translate(locale, 'media.gemini_uploads_help'), { exact: true }).waitFor();
      await addGoogleKey(page, locale);
      await toggleAndApply(page, locale, running.boots);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      expect(running.logs.join('\n')).not.toContain(KEY);
      expect(await readFile(join(home, 'models.json'), 'utf8')).not.toContain(KEY);
      expect(await readFile(join(home, 'dsh/profiles/swiftnest/cordis.patch.yml'), 'utf8')).not.toContain(KEY);
    } finally {
      await browser.close();
      await running.kernel.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
  90_000,
);
