/**
 * What the enabled plugins contribute to the `swiftnest` profile: npm packages
 * become profile dependencies and, once installed at their pinned version,
 * bundle layers, as do enabled bundles shipped with the kernel; the Tool Ultra
 * build and each loaded plugin's `patch` contribute patch rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';
import {
  type DshSource,
  enabledNpmPlugins,
  enabledPlugins,
  isEnabled,
  type NpmSource,
  type Plugin,
  pluginById,
} from './plugins.js';
import { isBuilt, TOOL_ULTRA_ID, toolUltraDir, toolUltraPatch } from './tool-ultra.js';

export interface ProfilePlugins {
  dependencies: Record<string, string>;
  bundles: string[];
  rows: unknown[];
  /** Ids of enabled plugins that are not installed yet. */
  missing: string[];
  /** Community market installs kept while the market is on. */
  unaudited: string[];
  /** Community market installs removed because the market is off. */
  dropped: string[];
}

export const MARKET_ID = 'market';

/** Installed means present in the profile at exactly the pinned version. */
export function isInstalled(profile: string, plugin: Plugin<NpmSource>): boolean {
  try {
    const manifest = readFileSync(join(profile, 'node_modules', plugin.source.package, 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version === plugin.source.version;
  } catch {
    return false;
  }
}

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

function readProfileManifest(profile: string): ProfileManifest {
  try {
    return JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as ProfileManifest;
  } catch {
    return {};
  }
}

/**
 * Packages someone installed outside the manifest, from the community plugin
 * market. They stay while the market is on (unaudited) and go once it is off.
 */
function keepMarketInstalls(config: ServerConfig, profile: string, plugins: ProfilePlugins): void {
  const previous = readProfileManifest(profile);
  const extra = Object.entries(previous.dependencies ?? {}).filter(([name]) => !(name in plugins.dependencies));
  if (!extra.length) return;
  const names = extra.map(([name]) => name);
  if (!isEnabled(pluginById(MARKET_ID, 'dsh'), config.plugins)) {
    plugins.dropped = names;
    return;
  }
  plugins.unaudited = names;
  Object.assign(plugins.dependencies, Object.fromEntries(extra));
  plugins.bundles.push(...(previous.dsh?.profile?.bundles ?? []).filter((name) => names.includes(name)));
}

function toolUltraRows(config: ServerConfig, missing: string[]): unknown[] {
  if (!isEnabled(pluginById(TOOL_ULTRA_ID, 'git'), config.plugins)) return [];
  const dir = toolUltraDir(config);
  if (isBuilt(dir)) return toolUltraPatch(dir);
  missing.push(TOOL_ULTRA_ID);
  return [];
}

export function profilePlugins(config: ServerConfig, profile: string): ProfilePlugins {
  const missing: string[] = [];
  const rows = toolUltraRows(config, missing);
  const dependencies: Record<string, string> = {};
  // Bundles shipped with the kernel are always present.
  const loaded: Plugin[] = enabledPlugins<DshSource>(config.plugins, 'dsh');
  for (const plugin of enabledNpmPlugins(config.plugins)) {
    dependencies[plugin.source.package] = plugin.source.version;
    if (isInstalled(profile, plugin)) loaded.push(plugin);
    else missing.push(plugin.id);
  }
  const bundles = loaded.map((plugin) => (plugin.source as DshSource | NpmSource).package);
  rows.push(...loaded.flatMap((plugin) => plugin.patch ?? []));
  const plugins = { dependencies, bundles, rows, missing, unaudited: [], dropped: [] };
  keepMarketInstalls(config, profile, plugins);
  return plugins;
}
