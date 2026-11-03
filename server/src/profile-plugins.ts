/**
 * What the enabled plugins contribute to the `swiftnest` profile: npm packages
 * become profile dependencies and, once installed at their pinned version,
 * bundle layers; the Tool Ultra build contributes patch rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';
import { enabledNpmPlugins, isEnabled, type NpmSource, type Plugin, pluginById } from './plugins.js';
import { isBuilt, TOOL_ULTRA_ID, toolUltraDir, toolUltraPatch } from './tool-ultra.js';

export interface ProfilePlugins {
  dependencies: Record<string, string>;
  bundles: string[];
  rows: unknown[];
  /** Ids of enabled plugins that are not installed yet. */
  missing: string[];
}

/** Installed means present in the profile at exactly the pinned version. */
export function isInstalled(profile: string, plugin: Plugin<NpmSource>): boolean {
  try {
    const manifest = readFileSync(join(profile, 'node_modules', plugin.source.package, 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version === plugin.source.version;
  } catch {
    return false;
  }
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
  const bundles: string[] = [];
  for (const plugin of enabledNpmPlugins(config.plugins)) {
    dependencies[plugin.source.package] = plugin.source.version;
    if (isInstalled(profile, plugin)) bundles.push(plugin.source.package);
    else missing.push(plugin.id);
  }
  return { dependencies, bundles, rows, missing };
}
