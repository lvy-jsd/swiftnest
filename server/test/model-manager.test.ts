import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelsView } from '@swiftnest/api';
import { loadConfig } from '../src/config.js';
import { ADMIN_TOKEN_ENV, ADMIN_URL_ENV, startDevices } from '../src/devices.js';
import { KernelApply } from '../src/kernel-apply.js';
import { ModelManager } from '../src/model-manager.js';
import {
  MODEL_PROVIDERS,
  ModelSettingsStore,
  modelKeyEnv,
  parseModelSettings,
  updateModelSettings,
} from '../src/model-settings.js';
import { message } from '../src/i18n.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-models-'));
  homes.push(home);
  const config = loadConfig(undefined, {
    SWIFTNEST_LANG: 'en',
    SWIFTNEST_HOME: home,
    SWIFTNEST_DEVICES_PORT: '0',
    SWIFTNEST_DEVICES_MDNS: 'false',
  });
  return { home, config };
}

function manager(home: string, restart = vi.fn(async () => {})) {
  const kernel = new KernelApply({ restart, fail: vi.fn(), log: vi.fn(), lang: 'en' });
  const models = new ModelManager(ModelSettingsStore.open(home), { kernel, changed: vi.fn() });
  return { models, kernel, restart };
}

async function settle(models: ModelManager, config: ReturnType<typeof setup>['config']): Promise<ModelsView> {
  await vi.waitFor(() => expect(models.busy).toBe(false));
  return models.view(config, 'en');
}

const KEY = 'sk-test-0123456789abcd';

describe('model settings', () => {
  it('keeps only valid routes to offered providers', () => {
    expect(
      parseModelSettings({
        main: { provider: 'deepseek', model: 'deepseek-v4-pro' },
        expert: { provider: 'nowhere', model: 'x' },
        expertApproval: 'sometimes',
      }),
    ).toEqual({ main: { provider: 'deepseek', model: 'deepseek-v4-pro' }, expertApproval: 'ask' });
  });

  it('rejects a whole update when any field is invalid, and clears a route with null', () => {
    const current = parseModelSettings({ expert: { provider: 'google', model: 'gemini-pro-latest' } });
    expect(updateModelSettings(current, { expert: null, expertApproval: 'auto' })).toEqual({ expertApproval: 'auto' });
    expect(() => updateModelSettings(current, { expert: { provider: 'google', model: 'bad model' } })).toThrow();
    expect(() => updateModelSettings(current, { main: null, extra: true })).toThrow();
  });

  it('names every offered provider in both languages', () => {
    const { home, config } = setup();
    const { models } = manager(home);
    for (const lang of ['en', 'zh-CN'] as const) {
      for (const provider of models.view(config, lang).providers) expect(provider.name, provider.id).toBeTruthy();
    }
    expect(MODEL_PROVIDERS.map((provider) => modelKeyEnv(provider.id))).toContain('SWIFTNEST_MODEL_KEY_MOONSHOTAI_CN');
  });

  it('stores keys owner-only, shows only their last four characters and passes them to the kernel', async () => {
    const { home, config } = setup();
    const { models } = manager(home);
    await models.setKey('deepseek', KEY);
    expect(statSync(join(home, 'model-keys.json')).mode & 0o777).toBe(0o600);
    expect(models.view(config, 'en').providers.find((p) => p.id === 'deepseek')).toMatchObject({ keyHint: 'abcd' });
    expect(JSON.stringify(models.view(config, 'en'))).not.toContain(KEY);
    expect(models.env()).toEqual({ SWIFTNEST_MODEL_KEY_DEEPSEEK: KEY });
    expect(ModelSettingsStore.open(home).key('deepseek')).toBe(KEY);
    await models.setKey('deepseek', '');
    expect(models.env()).toEqual({});
    await expect(models.setKey('nowhere', KEY)).rejects.toThrow(message('modelsUnknownProvider', 'en', ['nowhere']));
    await expect(models.setKey('deepseek', 'short')).rejects.toThrow(message('modelsInvalidKey', 'en'));
  });
});

describe('model manager', () => {
  it('uses a cloud route only once its provider has a key', async () => {
    const { home, config } = setup();
    const { models } = manager(home);
    await models.update({ main: { provider: 'deepseek', model: 'deepseek-v4-pro' } });
    expect(models.config(config).cloud).toEqual({ expertApproval: 'ask' });
    await models.setKey('deepseek', KEY);
    expect(models.config(config).cloud?.main).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });

  it('marks saved changes pending until the kernel restarts with them', async () => {
    const { home, config } = setup();
    let models: ModelManager;
    const restart = vi.fn(async () => models.loaded());
    ({ models } = manager(home, restart));
    expect(models.view(config, 'en').pending).toBe(false);
    await models.update({ expert: { provider: 'google', model: 'gemini-pro-latest' } });
    expect(models.view(config, 'en').pending).toBe(true);
    models.apply();
    const view = await settle(models, config);
    expect(restart).toHaveBeenCalledOnce();
    expect(view).toMatchObject({ pending: false, apply: { state: 'idle' } });
  });

  it('goes back to the models that last booted when the kernel does not start with the new ones', async () => {
    const { home, config } = setup();
    const restart = vi.fn().mockRejectedValueOnce(new Error('boot failed')).mockResolvedValue(undefined);
    const { models } = manager(home, restart);
    await models.update({ expertApproval: 'auto' });
    models.apply();
    const view = await settle(models, config);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(view).toMatchObject({ expertApproval: 'ask', apply: { state: 'failed', rolledBack: true } });
  });

  it('shares one restart with other settings pages', async () => {
    const { home } = setup();
    let finish = () => {};
    const restart = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { models, kernel } = manager(home, restart);
    kernel.start({ rollback: async () => {}, changed: () => {}, messages: busyMessages });
    expect(() => models.apply()).toThrow(message('modelsApplyBusy', 'en'));
    await vi.waitFor(() => expect(restart).toHaveBeenCalled());
    finish();
  });
});

const busyMessages = {
  applied: 'pluginsApplied',
  rolledBack: 'pluginsRolledBack',
  busy: 'pluginsApplyBusy',
} as const;

describe('model routes', () => {
  it('serves the model page API on the loopback admin server', async () => {
    const { config } = setup();
    const restartKernel = vi.fn(async () => {});
    const hub = await startDevices(config, { restartKernel, installPlugins: async () => {} });
    try {
      const api = (path: string, method = 'GET', body?: unknown) =>
        fetch(`${hub.env[ADMIN_URL_ENV]}/swiftnest/api/models${path}`, {
          method,
          headers: { authorization: `Bearer ${hub.env[ADMIN_TOKEN_ENV]}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const initial = (await (await api('')).json()) as ModelsView;
      expect(initial).toMatchObject({ local: { model: config.model.id }, expertApproval: 'ask', pending: false });
      const expert = { provider: 'deepseek', model: 'deepseek-v4-pro' };
      expect(await (await api('/settings', 'POST', { expert })).json()).toMatchObject({ expert, pending: true });
      expect((await api('/settings', 'POST', { expert: { provider: 'x', model: 'y' } })).status).toBe(400);
      const keyed = (await (await api('/keys/deepseek', 'POST', { key: KEY })).json()) as ModelsView;
      expect(keyed.providers.find((provider) => provider.id === 'deepseek')?.keyHint).toBe('abcd');
      expect((await api('/keys/nowhere', 'POST', { key: KEY })).status).toBe(404);
      expect((await api('/nope')).status).toBe(404);
      expect(hub.config().cloud?.expert).toEqual(expert);
      expect((await api('/apply', 'POST')).status).toBe(202);
      await vi.waitFor(() => expect(restartKernel).toHaveBeenCalledOnce());
    } finally {
      await hub.close();
    }
  });
});
