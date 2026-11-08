/** Tool Ultra's published package group and Swiftnest-owned configuration boundary. */
import { accessSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { ServerConfig } from './config.js';
import type { Log } from './command.js';
import { type NpmGroupSource, pluginById } from './plugins.js';

export const TOOL_ULTRA_ID = 'tool-ultra';
export const TOOL_ULTRA_SOURCE = pluginById<NpmGroupSource>(TOOL_ULTRA_ID, 'npm-group').source;
export const TOOL_ULTRA_PACKAGES = TOOL_ULTRA_SOURCE.packages;

/** Dependencies live in the existing DSH profile, never a second source checkout. */
export function toolUltraDir(config: ServerConfig): string {
  return join(config.home, 'dsh', 'profiles', 'swiftnest');
}

/** Every member must match its audited version and tarball before the group is loaded. */
export function isBuilt(profile: string): boolean {
  try {
    const lock = parse(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')) as {
      packages?: Record<string, { resolution?: { integrity?: string } }>;
    };
    return TOOL_ULTRA_PACKAGES.every((pkg) => {
      const manifest = JSON.parse(readFileSync(join(profile, 'node_modules', pkg.package, 'package.json'), 'utf8'));
      accessSync(toolUltraModule(profile, pkg.package));
      accessSync(join(profile, 'node_modules', pkg.package, 'cordis.patch.yml'));
      return (
        manifest.version === pkg.version &&
        lock.packages?.[`${pkg.package}@${pkg.version}`]?.resolution?.integrity === pkg.integrity
      );
    });
  } catch {
    return false;
  }
}

/** Resolve public package entry points using Node's exports, not the old workspace layout. */
export function toolUltraModule(profile: string, name: string): string {
  return createRequire(join(profile, 'package.json')).resolve(name);
}

interface PatchRow {
  insert: { name: string; config: Record<string, unknown> }[];
}

function configureMedia(entry: PatchRow['insert'][number], config: ServerConfig): void {
  const sourceModule = entry.name;
  entry.name = '@swiftnest/server-bundle/media';
  entry.config = {
    ...entry.config,
    sourceModule,
    outputDir: join(config.home, 'files', 'media'),
    inputDirs: [join(config.home, 'files')],
    modelCacheDir: join(config.home, 'models'),
    modelMirror: config.media?.modelMirror,
    geminiUploads: config.media?.geminiUploads === true,
    geminiKeyFile: join(config.home, 'media-gemini.key'),
    lang: config.lang ?? 'zh-CN',
  };
  delete entry.config.geminiApiKey;
  for (const key of ['soundfont', 'soundfontUrl'] as const) {
    if (config.media?.[key] !== undefined) entry.config[key] = config.media[key];
  }
}

/** Preserve upstream patches and defaults; only Swiftnest's documented overrides change. */
export function toolUltraPatch(profile: string, config?: ServerConfig): unknown[] {
  const require = createRequire(join(profile, 'package.json'));
  return TOOL_ULTRA_PACKAGES.flatMap((pkg) => {
    const packageDir = dirname(require.resolve(`${pkg.package}/package.json`));
    const rows = parse(readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')) as PatchRow[];
    for (const row of rows) {
      for (const entry of row.insert) {
        entry.name = require.resolve(pkg.package);
        if (pkg.package.endsWith('-pack-media') && config) configureMedia(entry, config);
        if (pkg.package.endsWith('-pack-mcp') && config) {
          entry.config = {
            ...entry.config,
            defaults: false,
            ...(config.mcp?.presets ? { presets: config.mcp.presets } : {}),
          };
        }
        if (pkg.package.endsWith('-capability-bridge') && config?.capabilities?.packs) {
          entry.config = { ...entry.config, packs: config.capabilities.packs };
        }
      }
    }
    return rows;
  });
}

/** Compatibility entry: install this group through the same audited profile installer. */
export async function installToolUltra(config: ServerConfig, log: Log): Promise<void> {
  const { installPlugins } = await import('./plugin-install.js');
  await installPlugins(config, log);
}
