import { channelPublicKey, type ChannelPairing } from '@swiftnest/channel';
import { channelAddresses } from '@swiftnest/server-bundle/trusted-proxy';
import { loadChannelIdentity } from '@swiftnest/server-bundle/channel-identity';
import { text } from '@swiftnest/core';
import { ServerFailure } from './i18n.js';
/**
 * Runs the pinned DSH kernel as a child process on the `swiftnest` profile and
 * reports the URL it serves. A child process keeps DSH's own lifecycle,
 * reload and crash handling intact, and lets the kernel use the official Node
 * build its native addon needs (see docs/en/dev/dsh-integration.md).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevices } from './devices.js';
import type { ServerConfig } from './config.js';
import { withLocalFacts } from './model-probe.js';
import { PROFILE_NAME, dshHome, profileDir, writeProfile } from './profile.js';

const require = createRequire(import.meta.url);

const activeKernels = new Set<RunningKernel>();

export function getActiveKernels(): ReadonlySet<RunningKernel> {
  return activeKernels;
}

export async function stopAllKernels(): Promise<void> {
  const owned = [...activeKernels];
  activeKernels.clear();
  const results = await Promise.allSettled(owned.map((kernel) => kernel.stop()));
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'Kernel cleanup failed');
}

export interface KernelPaths {
  dshBin: string;
  dshVersion: string;
  bundleDir: string;
  swiftnestVersion: string;
  appDist?: string;
}

/** Optional App package: explicit config wins; never assume a source checkout layout. */
export function resolveAppDist(
  resolvePackage: (id: string) => string = (id) => require.resolve(id),
): string | undefined {
  try {
    return join(dirname(resolvePackage('@swiftnest/app/package.json')), 'dist');
  } catch {
    return undefined;
  }
}

export function resolveKernel(): KernelPaths {
  const dshPkg = require.resolve('@deepseek-ai/dsh/package.json');
  const bundlePkg = require.resolve('@swiftnest/server-bundle/package.json');
  const ownPkg = require.resolve('../package.json');
  return {
    swiftnestVersion: (JSON.parse(readFileSync(ownPkg, 'utf8')) as { version: string }).version,
    dshBin: join(dirname(dshPkg), 'lib', 'bin.js'),
    dshVersion: (JSON.parse(readFileSync(dshPkg, 'utf8')) as { version: string }).version,
    bundleDir: dirname(bundlePkg),
    appDist: resolveAppDist(),
  };
}

type Devices = Awaited<ReturnType<typeof startDevices>>;

export interface RunningKernel {
  /** Root URL the kernel serves, without the launch token. */
  readonly url: string;
  /** Per-process launch token; trades for a session cookie at `/` or `/connect`. Changes on restart. */
  readonly token: string;
  readonly channelPairing: ChannelPairing;
  readonly child: ChildProcess;
  devices: Devices;
  stop(): Promise<void>;
  /** Stop DSH and start it again with a freshly written profile; the device hub keeps running. */
  restart(): Promise<void>;
  /** Runs when DSH exits on its own (not through stop or restart); the device hub is closed by then. */
  onExit(listener: (code: number | null) => void): void;
}

export interface StartOptions {
  /** Node executable for the kernel; defaults to $SWIFTNEST_KERNEL_NODE, then the one running Swiftnest. */
  node?: string;
  /** Extra environment for the kernel (API keys, proxies). */
  env?: NodeJS.ProcessEnv;
  /** Receives every kernel output line. */
  onLine?: (line: string) => void;
  /** Runs each time DSH is ready, including after a restart. */
  onReady?: (kernel: RunningKernel) => void;
  readyTimeoutMs?: number;
}

/** `dsh web: http://127.0.0.1:3077/?token=…` */
const READY_LINE = /dsh web:\s*(https?:\/\/\S+)/;

export function parseReadyLine(line: string): { url: string; token: string } | undefined {
  const match = READY_LINE.exec(line);
  if (!match?.[1]) return undefined;
  let full: URL;
  try {
    full = new URL(match[1]);
  } catch {
    return undefined;
  }
  const token = full.searchParams.get('token');
  if (!token) return undefined;
  full.search = '';
  return { url: full.toString(), token };
}

interface DshProcess {
  child: ChildProcess;
  url: string;
  token: string;
}

export function stopChild(child: ChildProcess, graceMs = 5000): Promise<void> {
  return new Promise<void>((resolveStop) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolveStop();
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

function spawnDsh(config: ServerConfig, paths: KernelPaths, devices: Devices, opts: StartOptions): ChildProcess {
  const args = [
    '--import',
    fileURLToPath(new URL(`./kernel-parent-guard.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)),
    paths.dshBin,
    '--profile',
    PROFILE_NAME,
    '--patch',
    join(profileDir(config), 'user.patch.yml'),
    '--no-open',
    '--host',
    config.host,
    '--port',
    String(config.port),
  ];
  return spawn(opts.node ?? process.env.SWIFTNEST_KERNEL_NODE ?? process.execPath, args, {
    cwd: config.home,
    env: {
      ...process.env,
      ...opts.env,
      ...devices.env,
      ...devices.models.env(),
      SWIFTNEST_RELAY_ADDRESS: config.relay?.address ?? '',
      SWIFTNEST_RELAY_SECRET: config.relay?.secret ?? '',
      SWIFTNEST_LANG: config.lang ?? 'zh-CN',
      DSH_HOME: dshHome(config),
      SWIFTNEST_HOME: config.home,
      SWIFTNEST_MEMORY: String(config.memory?.enabled ?? true),
      SWIFTNEST_MEMORY_AUTO: String(config.memory?.auto ?? true),
      SWIFTNEST_SEARCH_CONFIG: JSON.stringify(config.search ?? {}),
      SWIFTNEST_WEB_FETCH_ORIGINS: JSON.stringify(config.webFetch?.allowOrigins ?? []),
      SWIFTNEST_SEARCH_LOCAL_MODEL: config.model.id,
      SWIFTNEST_SEARCH_LOCAL_KEY_ENV: config.model.apiKeyEnv,
      SWIFTNEST_VERSION: paths.swiftnestVersion,
      SWIFTNEST_DSH_VERSION: paths.dshVersion,
      SWIFTNEST_MODEL_BASE_URL: config.model.baseUrl,
      SWIFTNEST_APP_DIST: config.appDist ?? opts.env?.SWIFTNEST_APP_DIST ?? paths.appDist ?? '',
      [config.model.apiKeyEnv]: opts.env?.[config.model.apiKeyEnv] ?? process.env[config.model.apiKeyEnv] ?? 'none',
    },
    // A dedicated IPC descriptor closes even when the parent receives SIGKILL.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

const NODE_HINT = '\nHint: DSH needs Node from nodejs.org; point SWIFTNEST_KERNEL_NODE at that node binary.';

/** Resolve with DSH's URL once it prints the ready line; on any failure, stop it and reject with its output. */
function waitReady(child: ChildProcess, opts: StartOptions): Promise<DshProcess> {
  return new Promise<DshProcess>((resolveStart, rejectStart) => {
    let settled = false;
    const tail: string[] = [];
    const timer = setTimeout(
      () => fail(new ServerFailure(text('dshKernelDidNotReportReady'))),
      opts.readyTimeoutMs ?? 60_000,
    );
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = tail.some((l) => l.includes('node-addon-require-builtin')) ? NODE_HINT : '';
      const failure = new ServerFailure(text('kernelOutput', err.message, hint, tail.join('\n')));
      void stopChild(child).then(() => rejectStart(failure));
    };
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        opts.onLine?.(line.replace(/token=[^&\s]+/g, 'token=…'));
        tail.push(line.replace(/token=[^&\s]+/g, 'token=…'));
        if (tail.length > 40) tail.shift();
        const ready = settled ? undefined : parseReadyLine(line);
        if (ready) {
          settled = true;
          clearTimeout(timer);
          resolveStart({ ...ready, child });
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new ServerFailure(text('dshKernelExited', String(signal ?? code)))));
  });
}

/** Write the profile with the owner's current plugins and models, then start DSH on it. */
async function launch(paths: KernelPaths, devices: Devices, opts: StartOptions): Promise<DshProcess> {
  const base = devices.config();
  const config = { ...base, model: await withLocalFacts(base.model) };
  const { plugins } = writeProfile(config, { bundleDir: paths.bundleDir });
  devices.plugins.loaded(plugins);
  devices.models.loaded(config.model);
  const ready = await waitReady(spawnDsh(config, paths, devices, opts), opts);
  try {
    devices.tools.loaded();
    return ready;
  } catch (error) {
    await stopChild(ready.child);
    throw error;
  }
}

class Kernel implements RunningKernel {
  private exitListeners: ((code: number | null) => void)[] = [];
  /** Set while stop or restart ends the current child on purpose. */
  private ending = false;
  private stopped = false;
  private operations: Promise<void> = Promise.resolve();
  private stopping?: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    private current: DshProcess,
    readonly devices: Devices,
    private readonly publicKey: string,
    private readonly relaunch: () => Promise<DshProcess>,
    private readonly ready: (kernel: RunningKernel) => void,
    private readonly channelEnv: NodeJS.ProcessEnv,
  ) {
    this.watch(current.child);
  }

  get channelPairing(): ChannelPairing {
    return {
      v: 1,
      key: this.publicKey,
      addresses: { lan: channelAddresses(this.url, this.channelEnv), relay: this.relayAddresses() },
    };
  }

  private relayAddresses(): string[] {
    try {
      const saved = JSON.parse(readFileSync(join(this.devices.plugins.config().home, 'relay.json'), 'utf8'));
      return saved?.address ? [saved.address] : [];
    } catch {
      return this.devices.plugins.config().relay ? [this.devices.plugins.config().relay!.address] : [];
    }
  }

  get url() {
    return this.current.url;
  }
  get token() {
    return this.current.token;
  }
  get child() {
    return this.current.child;
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  private watch(child: ChildProcess): void {
    child.once('exit', (code) => {
      if (!this.ending && child === this.current.child) this.fail(code);
    });
  }

  /** DSH is gone and will not come back: close the hub and tell the listeners. */
  fail(code: number | null = 1): void {
    if (this.stopped) return;
    this.stopped = true;
    activeKernels.delete(this);
    void this.closeDevices().then(() => {
      for (const listener of this.exitListeners) listener(code);
    });
  }

  private closeDevices(): Promise<void> {
    this.closing ??= this.devices.close();
    return this.closing;
  }

  restart(): Promise<void> {
    const operation = this.operations.then(async () => {
      if (this.stopped) return;
      this.ending = true;
      try {
        await stopChild(this.current.child);
        this.current = await this.relaunch();
        this.watch(this.current.child);
        if (!this.stopped) this.ready(this);
      } finally {
        this.ending = false;
      }
    });
    this.operations = operation.catch(() => {});
    return operation;
  }

  stop(): Promise<void> {
    this.stopped = true;
    activeKernels.delete(this);
    this.stopping ??= this.operations.then(async () => {
      this.ending = true;
      try {
        await stopChild(this.current.child);
      } finally {
        await this.closeDevices();
      }
    });
    return this.stopping;
  }
}

export async function startKernel(config: ServerConfig, opts: StartOptions = {}): Promise<RunningKernel> {
  const publicKey = channelPublicKey(await loadChannelIdentity(config.home));
  const paths = resolveKernel();
  let kernel: Kernel | undefined;
  const devices = await startDevices(config, {
    restartKernel: () => kernel?.restart() ?? Promise.resolve(),
    kernelFailed: () => kernel?.fail(),
  });
  let first: DshProcess;
  try {
    first = await launch(paths, devices, opts);
  } catch (error) {
    await devices.close();
    throw error;
  }
  const ready = opts.onReady ?? (() => {});
  kernel = new Kernel(first, devices, publicKey, () => launch(paths, devices, opts), ready, {
    ...process.env,
    ...opts.env,
  });
  try {
    ready(kernel);
    activeKernels.add(kernel);
    kernel.onExit(() => {
      activeKernels.delete(kernel);
    });
    return kernel;
  } catch (error) {
    await kernel.stop();
    throw error;
  }
}
