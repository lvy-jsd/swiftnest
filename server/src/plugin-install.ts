/**
 * `swiftnest-server plugins install`: install all enabled exact npm packages
 * (including the Tool Ultra group) with DSH's own profile package command,
 * then check every installed tarball against the audited manifest integrity.
 */
import { text } from '@swiftnest/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type Log, run } from './command.js';
import type { ServerConfig } from './config.js';
import { message, ServerFailure } from './i18n.js';
import { resolveKernel } from './kernel.js';
import { enabledNpmPlugins, type NpmSource, type Plugin } from './plugins.js';
import { dshHome, PROFILE_NAME, writeProfile } from './profile.js';

interface PnpmLock {
  packages?: Record<string, { resolution?: { integrity?: string } }>;
}

/** Fail unless pnpm resolved each plugin to exactly the audited tarball. */
export function verifyIntegrity(profile: string, plugins: Plugin<NpmSource>[]): void {
  const lock = parse(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')) as PnpmLock;
  for (const { id, source } of plugins) {
    const resolved = lock.packages?.[`${source.package}@${source.version}`]?.resolution?.integrity;
    if (resolved !== source.integrity) throw new ServerFailure(text('pluginIntegrityMismatch', id));
  }
}

async function installNpmPlugins(config: ServerConfig, log: Log): Promise<void> {
  const plugins = enabledNpmPlugins(config.plugins);
  if (!plugins.length) return;
  const kernel = resolveKernel();
  const { dir: profile } = writeProfile(config, { bundleDir: kernel.bundleDir, log: () => {} });
  log(message('pluginsInstalling', config.lang, [[...new Set(plugins.map((plugin) => plugin.id))].join(', ')]));
  const env = { ...process.env, DSH_HOME: dshHome(config) };
  await run(process.execPath, [kernel.dshBin, 'plugin', '--profile', PROFILE_NAME, 'install'], profile, env, log);
  verifyIntegrity(profile, plugins);
}

export async function installPlugins(config: ServerConfig, log: Log): Promise<void> {
  await installNpmPlugins(config, log);
  log(message('pluginsInstalled', config.lang));
}
