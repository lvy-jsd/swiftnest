import { openSettingsPage } from './navigation';
/**
 * Real App + real DSH kernel: a beginner adds a cloud expert on the model page, applies,
 * the kernel restarts with it and the page comes back on its own. The expert's key is
 * fake and no chat is sent, so no request leaves the machine.
 */
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
import { translate } from '../src/i18n';
import { launchChromium } from './browser';

const KEY = 'sk-e2e-not-a-real-key-wxyz';
const en = (key: Parameters<typeof translate>[1]) => translate('en', key);

async function modelsView(page: Page): Promise<ModelsView> {
  return page.evaluate(async () => (await fetch('/swiftnest/api/models')).json());
}

/** Set SWIFTNEST_SCREENSHOTS to a folder to see the page while changing it. */
async function shot(page: Page, name: string) {
  const dir = process.env.SWIFTNEST_SCREENSHOTS;
  if (dir) await page.screenshot({ path: join(dir, `models-${name}.png`) });
}

async function addExpert(page: Page) {
  await page.getByRole('button', { name: en('modelsExpertAdd'), exact: true }).click();
  const save = page.getByRole('button', { name: en('modelsSave'), exact: true });
  expect(await save.isDisabled()).toBe(true);
  await page.getByRole('radio', { name: 'DeepSeek' }).check();
  expect(await page.getByRole('link', { name: en('modelsGetKey') }).getAttribute('href')).toContain('deepseek.com');
  await page.getByLabel(en('modelsKey')).fill(KEY);
  await shot(page, 'sheet');
  await save.click();
  await page.getByText('DeepSeek · deepseek-v4-pro', { exact: true }).first().waitFor();
}

async function applyAndReturn(page: Page, readyCount: () => number) {
  await page.getByRole('button', { name: en('pluginsApply'), exact: true }).click();
  await expect.poll(readyCount, { timeout: 30_000 }).toBe(2);
  const remove = page.getByRole('button', { name: en('modelsExpertRemove'), exact: true });
  await expect.poll(() => remove.isEnabled(), { timeout: 20_000 }).toBe(true);
  expect(await modelsView(page)).toMatchObject({
    expert: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    pending: false,
    apply: { state: 'idle' },
  });
  expect(page.url()).toContain('#/models');
}

async function removeKey(page: Page) {
  const askFirst = page.getByRole('switch', { name: en('modelsAskFirst') });
  expect(await askFirst.isChecked()).toBe(true);
  await askFirst.click();
  await expect.poll(async () => (await modelsView(page)).expertApproval).toBe('auto');
  await page.getByRole('button', { name: en('modelsKeyRemove'), exact: true }).click();
  await page.getByText(en('modelsExpertNone'), { exact: true }).waitFor();
  const view = await modelsView(page);
  expect(view.expert).toBeUndefined();
  expect(view.providers.find((provider) => provider.id === 'deepseek')?.keyHint).toBeUndefined();
}

it.skipIf(process.env.SWIFTNEST_E2E !== '1' || process.env.SWIFTNEST_WEB_E2E !== '1')(
  'a beginner adds a cloud expert, applies, and the page reconnects to the restarted kernel',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-models-real-'));
    const browser = await launchChromium();
    const logs: string[] = [];
    let readyCount = 0;
    const config = loadConfig(undefined, {
      SWIFTNEST_HOME: home,
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOST: '127.0.0.1',
      SWIFTNEST_PORT: '0',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_PLUGINS: 'tool-ultra=false',
      SWIFTNEST_APP_DIST: fileURLToPath(new URL('../dist/', import.meta.url)),
      SWIFTNEST_MODEL_ID: 'fake',
      SWIFTNEST_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
    });
    const kernel = await startKernel(config, {
      readyTimeoutMs: 30_000,
      onReady(running) {
        // Keep the origin and its session cookie across the restart.
        config.port = Number(new URL(running.url).port);
        ++readyCount;
      },
      onLine: (line) => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      await page.goto(webAppUrl(kernel.url, kernel.token));
      await openSettingsPage(page, 'shell.models');
      await page.getByText('fake', { exact: false }).first().waitFor();
      await addExpert(page);
      await applyAndReturn(page, () => readyCount);
      await shot(page, 'page');
      await removeKey(page);
      expect(errors).toEqual([]);
      expect(logs.join('\n')).not.toContain(KEY);
      expect(await readFile(join(home, 'models.json'), 'utf8')).not.toContain(KEY);
    } catch (error) {
      throw new Error(`${String(error)}\n${logs.slice(-40).join('\n')}`, { cause: error });
    } finally {
      await browser.close();
      await kernel.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
  90_000,
);
