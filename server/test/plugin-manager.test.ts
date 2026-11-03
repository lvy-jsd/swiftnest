import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginsView } from '@swiftnest/api';
import { loadConfig } from '../src/config.js';
import { ADMIN_TOKEN_ENV, ADMIN_URL_ENV, startDevices } from '../src/devices.js';
import { PluginManager, type PluginManagerDeps, pluginText } from '../src/plugin-manager.js';
import { pluginSettingsFile, readPluginSettings, withPluginSettings } from '../src/plugin-settings.js';
import { PLUGIN_MANIFEST } from '../src/plugins.js';
import { profilePlugins } from '../src/profile-plugins.js';
import { profileDir } from '../src/profile.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-plugin-manager-'));
  homes.push(home);
  const config = loadConfig(undefined, {
    SWIFTNEST_LANG: 'en',
    SWIFTNEST_HOME: home,
    SWIFTNEST_DEVICES_PORT: '0',
    SWIFTNEST_DEVICES_MDNS: 'false',
    ...env,
  });
  return { home, config };
}

function deps(overrides: Partial<PluginManagerDeps> = {}): PluginManagerDeps {
  return {
    install: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    fail: vi.fn(),
    changed: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

/** A manager whose kernel booted with the current switches, as `startKernel` does. */
function boot(manager: PluginManager) {
  manager.loaded(profilePlugins(manager.config(), profileDir(manager.config())));
}

async function settle(manager: PluginManager): Promise<PluginsView> {
  await vi.waitFor(() => expect(manager.busy).toBe(false));
  return manager.view('en');
}

const find = (view: PluginsView, id: string) => view.plugins.find((plugin) => plugin.id === id)!;

describe('plugin catalog', () => {
  it.each(['en', 'zh-CN'] as const)('names and describes every plugin in %s, with a note for opt-in ones', (lang) => {
    for (const plugin of PLUGIN_MANIFEST.plugins) {
      expect(pluginText(plugin.id, 'Title', lang), plugin.id).toBeTruthy();
      expect(pluginText(plugin.id, 'Summary', lang), plugin.id).toBeTruthy();
      if (!plugin.enabled) expect(pluginText(plugin.id, 'Note', lang), plugin.id).toBeTruthy();
    }
  });
});

describe('plugin settings', () => {
  it('ignores switches for plugins the manifest no longer has', () => {
    const { home } = setup();
    writeFileSync(pluginSettingsFile(home), JSON.stringify({ plugins: { im: true, gone: true, market: 'yes' } }));
    expect(readPluginSettings(home)).toEqual({ im: true });
  });

  it("lets the administrator's SWIFTNEST_PLUGINS win over the App", () => {
    const { config } = setup({ SWIFTNEST_PLUGINS: 'market=false' });
    expect(withPluginSettings(config, { market: true, im: true }).plugins).toMatchObject({ market: false, im: true });
  });
});

describe('plugin manager', () => {
  it('lists the audited plugins in the owner language with what the kernel loaded', () => {
    const { config } = setup({ SWIFTNEST_PLUGINS: 'tool-ultra=false' });
    const manager = new PluginManager(config, deps());
    boot(manager);
    const view = manager.view('zh-CN');
    expect(view.plugins.map((plugin) => plugin.id)).toEqual(PLUGIN_MANIFEST.plugins.map((plugin) => plugin.id));
    expect(find(view, 'market')).toMatchObject({
      title: '社区插件市场',
      enabled: false,
      recommended: false,
      active: false,
      locked: false,
      note: expect.stringContaining('没有经过 Swiftnest 检查'),
    });
    expect(find(view, 'tool-ultra')).toMatchObject({ enabled: false, locked: true });
    // Nothing is installed in a fresh home, so the recommended npm plugins still wait for an apply.
    expect(find(view, 'safety-net')).toMatchObject({ enabled: true, active: false, recommended: true });
    expect(view).toMatchObject({ unaudited: [], pending: true, apply: { state: 'idle' } });
  });

  it('labels community market installs as unaudited', () => {
    const { config } = setup();
    const profile = profileDir(config);
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dependencies: { 'cc-safety-net': '2.7.2', x: '1' } }),
    );
    expect(new PluginManager(config, deps()).view('en').unaudited).toEqual(['x']);
  });

  it('saves a switch for the next apply and refuses locked or unknown plugins', async () => {
    const { config, home } = setup({ SWIFTNEST_PLUGINS: 'im=false' });
    const hooks = deps();
    const manager = new PluginManager(config, hooks);
    boot(manager);
    await manager.set('market', true);
    expect(JSON.parse(readFileSync(pluginSettingsFile(home), 'utf8'))).toEqual({ plugins: { market: true } });
    expect(find(manager.view('en'), 'market')).toMatchObject({ enabled: true, active: false });
    expect(manager.view('en').pending).toBe(true);
    expect(hooks.changed).toHaveBeenCalled();
    await expect(manager.set('im', true)).rejects.toThrow('set by the server administrator');
    await expect(manager.set('nope', true)).rejects.toThrow('nope');
  });

  it('installs with the new switches, restarts the kernel and reports progress', async () => {
    const { config } = setup();
    let manager: PluginManager;
    const hooks = deps({ restart: vi.fn(async () => boot(manager)) });
    manager = new PluginManager(config, hooks);
    boot(manager);
    await manager.set('market', true);
    manager.apply();
    expect(manager.view('en').apply.state).toBe('installing');
    expect(() => manager.apply()).toThrow('already being applied');
    const view = await settle(manager);
    expect(hooks.install).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: expect.objectContaining({ market: true }) }),
      hooks.log,
    );
    expect(hooks.restart).toHaveBeenCalledOnce();
    expect(view.apply).toEqual({ state: 'idle' });
    expect(find(view, 'market')).toMatchObject({ enabled: true, active: true });
  });

  it('reports a failed installation without restarting', async () => {
    const { config } = setup();
    const hooks = deps({ install: vi.fn(async () => Promise.reject(new Error('offline'))) });
    const manager = new PluginManager(config, hooks);
    manager.apply();
    const view = await settle(manager);
    expect(hooks.restart).not.toHaveBeenCalled();
    expect(view.apply).toMatchObject({ state: 'failed', error: { message: 'offline' } });
    expect(view.apply.rolledBack).toBeUndefined();
  });

  it('goes back to the plugins that last booted when the kernel does not start with the new ones', async () => {
    const { config, home } = setup();
    const restart = vi.fn().mockRejectedValueOnce(new Error('boot failed')).mockResolvedValue(undefined);
    const manager = new PluginManager(config, deps({ restart }));
    boot(manager);
    await manager.set('market', true);
    manager.apply();
    const view = await settle(manager);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(view.apply).toMatchObject({ state: 'failed', rolledBack: true, error: { message: 'boot failed' } });
    expect(find(view, 'market').enabled).toBe(false);
    expect(readPluginSettings(home)).toEqual({});
  });

  it('gives up when even the previous plugins do not start', async () => {
    const { config } = setup();
    const hooks = deps({ restart: vi.fn(async () => Promise.reject(new Error('broken'))) });
    const manager = new PluginManager(config, hooks);
    manager.apply();
    await settle(manager);
    expect(hooks.fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken' }));
  });
});

describe('plugin routes', () => {
  it('serves the plugin page API on the loopback admin server', async () => {
    const { config } = setup({ SWIFTNEST_PLUGINS: 'tool-ultra=false' });
    const restartKernel = vi.fn(async () => {});
    const hub = await startDevices(config, { restartKernel, installPlugins: async () => {} });
    try {
      const api = (path: string, method = 'GET') =>
        fetch(`${hub.env[ADMIN_URL_ENV]}/swiftnest/api/plugins${path}`, {
          method,
          headers: { authorization: `Bearer ${hub.env[ADMIN_TOKEN_ENV]}` },
        });
      expect(find(await (await api('')).json(), 'market').enabled).toBe(false);
      expect(find(await (await api('/market/enable', 'POST')).json(), 'market').enabled).toBe(true);
      const locked = await api('/tool-ultra/enable', 'POST');
      expect(locked.status).toBe(409);
      expect(await locked.json()).toMatchObject({ code: 'SWIFTNEST_PLUGINLOCKEDBYSERVER' });
      expect((await api('/nope/enable', 'POST')).status).toBe(404);
      expect((await api('/market/remove', 'POST')).status).toBe(404);
      const applied = await api('/apply', 'POST');
      expect(applied.status).toBe(202);
      await vi.waitFor(() => expect(restartKernel).toHaveBeenCalledOnce());
    } finally {
      await hub.close();
    }
  });
});
