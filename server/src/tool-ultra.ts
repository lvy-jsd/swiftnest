/** Build the unpublished Tool Ultra source; defaults belong to its package patches. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ServerConfig } from './config.js';
import { message, ServerFailure } from './i18n.js';

export const TOOL_ULTRA_SOURCE = {
  repo: 'https://github.com/lvy-jsd/dsh-tool-ultra',
  commit: '8ccfefa1a922ad407e57ecbe6ea8b68e24adcbd9',
} as const;
export const TOOL_ULTRA_PACKAGES = [
  'core',
  'classifier-rules',
  'risk-gate',
  'persist',
  'pack-essentials',
  'pack-web',
  'devices',
] as const;
export const TOOL_ULTRA_MARKER = '.swiftnest-built';

type Log = (line: string) => void;

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

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: Log): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (stream: NodeJS.ReadableStream) => {
      let pending = '';
      stream.on('data', (chunk: Buffer) => {
        const lines = (pending + chunk.toString('utf8')).split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) if (line) log(line);
      });
      stream.on('end', () => {
        if (pending) log(pending);
      });
    };
    collect(child.stdout!);
    collect(child.stderr!);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new ServerFailure(message('toolUltraCommandFailed', 'en', [command, code])));
    });
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
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
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
  await execute('git', ['fetch', '--depth', '1', TOOL_ULTRA_SOURCE.repo, TOOL_ULTRA_SOURCE.commit]);
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
  writeFileSync(join(dir, TOOL_ULTRA_MARKER), TOOL_ULTRA_SOURCE.commit + '\n');
}

export async function installToolUltra(config: ServerConfig, log: Log): Promise<void> {
  const dir = toolUltraDir(config);
  if (isBuilt(dir)) {
    log(message('toolUltraAlreadyBuilt', config.lang, [dir]));
    return;
  }
  mkdirSync(dirname(dir), { recursive: true });
  // Do not let concurrent installers delete one another's in-progress checkout.
  const lock = dir + '.installing';
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new ServerFailure(message('toolUltraInstallBusy', 'en', [lock]));
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
