/** Build the unpublished Tool Ultra source; defaults belong to its package patches. */
import { text } from '@swiftnest/core';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ServerConfig } from './config.js';
import { type Log, run } from './command.js';
import { message, ServerFailure } from './i18n.js';
import { type GitSource, pluginById } from './plugins.js';

export const TOOL_ULTRA_ID = 'tool-ultra';
/** The pin lives in the plugin manifest with every other plugin. */
export const TOOL_ULTRA_SOURCE = pluginById<GitSource>(TOOL_ULTRA_ID, 'git').source;
export const TOOL_ULTRA_PACKAGES = TOOL_ULTRA_SOURCE.packages;
export const TOOL_ULTRA_MARKER = '.swiftnest-built';

export function toolUltraDir(config: ServerConfig): string {
  return resolve(config.home, 'vendor', `dsh-tool-ultra-${TOOL_ULTRA_SOURCE.commit.slice(0, 12)}`);
}

export function isBuilt(dir: string): boolean {
  try {
    return readFileSync(join(dir, TOOL_ULTRA_MARKER), 'utf8').trim() === TOOL_ULTRA_SOURCE.commit;
  } catch {
    return false;
  }
}

/** Preserve each upstream row and its config, changing only the module location. */
export function toolUltraPatch(dir: string): unknown[] {
  return TOOL_ULTRA_PACKAGES.flatMap((pkg) => {
    const packageDir = resolve(dir, 'packages', `dsh-tool-ultra-${pkg}`);
    const rows = parse(readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')) as { insert: { name: string }[] }[];
    for (const row of rows) {
      for (const entry of row.insert) entry.name = join(packageDir, 'lib', 'index.js');
    }
    return rows;
  });
}

/** Upstream link-host expects flat node_modules; resolve the actual pinned host under pnpm too. */
function prepareHost(dir: string): string {
  const require = createRequire(import.meta.url);
  const host = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
  const app = join(dir, '.swiftnest-host');
  for (const peer of ['dsh-tools', 'dsh-llm', 'dsh-mcp-client']) {
    const name = `@deepseek-ai/${peer}`;
    const link = join(app, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(dirname(host.resolve(`${name}/package.json`)), link, 'junction');
  }
  return app;
}

/** Keep the pinned source while replacing its vulnerable calculator dependency. */
function prepareDependencies(dir: string): void {
  const manifestFile = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const overrides = JSON.parse(readFileSync(new URL('../vendor/tool-ultra-overrides.json', import.meta.url), 'utf8'));
  manifest.overrides = { ...manifest.overrides, ...overrides };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, 'package-lock.json'),
    readFileSync(new URL('../vendor/tool-ultra.package-lock.json', import.meta.url)),
  );
}

async function build(dir: string, config: ServerConfig, log: Log): Promise<void> {
  // Upstream deliberately omits a lock. Ship one for this commit so npm ci is reproducible.
  const env = { ...process.env, DSH_APP: prepareHost(dir) };
  const execute = (command: string, args: string[]) => run(command, args, dir, env, log);
  log(message('toolUltraFetch', config.lang, [TOOL_ULTRA_SOURCE.commit]));
  await execute('git', ['init']);
  await execute('git', ['fetch', '--depth', '1', TOOL_ULTRA_SOURCE.repository, TOOL_ULTRA_SOURCE.commit]);
  await execute('git', ['checkout', '--detach', 'FETCH_HEAD']);
  prepareDependencies(dir);
  log(message('toolUltraDependencies', config.lang));
  await execute('npm', ['ci']);
  log(message('toolUltraBuild', config.lang));
  await execute('npm', ['run', 'build']);
  // Verify all selected entry points before declaring the installation ready.
  toolUltraPatch(dir);
  for (const pkg of TOOL_ULTRA_PACKAGES)
    readFileSync(join(dir, 'packages', `dsh-tool-ultra-${pkg}`, 'lib', 'index.js'));
  writeFileSync(join(dir, TOOL_ULTRA_MARKER), `${TOOL_ULTRA_SOURCE.commit}\n`);
}

export async function installToolUltra(config: ServerConfig, log: Log): Promise<void> {
  const dir = toolUltraDir(config);
  if (isBuilt(dir)) {
    log(message('toolUltraAlreadyBuilt', config.lang, [dir]));
    return;
  }
  mkdirSync(dirname(dir), { recursive: true });
  // Do not let concurrent installers delete one another's in-progress checkout.
  const lock = `${dir}.installing`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new ServerFailure(text('toolUltraInstallBusy', lock));
  }
  try {
    if (isBuilt(dir)) return;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    await build(dir, config, log);
    log(message('toolUltraInstalled', config.lang, [dir]));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
