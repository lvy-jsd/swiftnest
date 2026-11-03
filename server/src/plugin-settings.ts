/**
 * The owner's plugin switches from the App, saved in `<home>/plugin-settings.json`.
 * Precedence, lowest first: manifest default, config file, App, SWIFTNEST_PLUGINS.
 */
import { join } from 'node:path';
import type { ServerConfig } from './config.js';
import { readJsonFile } from './json-store.js';
import { PLUGIN_MANIFEST } from './plugins.js';

export type PluginSwitches = Record<string, boolean>;

export function pluginSettingsFile(home: string): string {
  return join(home, 'plugin-settings.json');
}

/** Saved switches for plugins the manifest still has; entries for removed plugins are ignored. */
export function readPluginSettings(home: string): PluginSwitches {
  const saved = (readJsonFile(pluginSettingsFile(home)) as { plugins?: unknown } | null | undefined)?.plugins;
  const switches: PluginSwitches = {};
  for (const { id } of PLUGIN_MANIFEST.plugins) {
    const value = (saved as Record<string, unknown> | undefined)?.[id];
    if (typeof value === 'boolean') switches[id] = value;
  }
  return switches;
}

export function withPluginSettings(config: ServerConfig, switches: PluginSwitches): ServerConfig {
  return { ...config, plugins: { ...config.plugins, ...switches, ...config.pluginLocks } };
}
