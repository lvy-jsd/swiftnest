import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startDevices } from '../src/devices.js';
import { startKernel, stopAllKernels } from '../src/kernel.js';

const fixture = fileURLToPath(new URL('./fixtures/lifecycle-kernel.mjs', import.meta.url));
const guard = fileURLToPath(new URL('../src/kernel-parent-guard.ts', import.meta.url));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(mode = 'ready', readyTimeoutMs = 2000) {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-lifecycle-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const config = loadConfig(undefined, {
    SWIFTNEST_HOME: home,
    SWIFTNEST_LANG: 'en',
    SWIFTNEST_PORT: '0',
    SWIFTNEST_DEVICES_PORT: '0',
    SWIFTNEST_DEVICES_MDNS: 'false',
    SWIFTNEST_PLUGINS: 'tool-ultra=false',
    SWIFTNEST_SEARCH: 'false',
  });
  const processes: { pid: number; port: number }[] = [];
  const options = {
    env: {
      NODE_OPTIONS: `--import=${JSON.stringify(fixture)} --import=${JSON.stringify(guard)}`,
      LIFECYCLE_MODE: mode,
      LIFECYCLE_PRELOAD: '1',
    },
    readyTimeoutMs,
    onLine(line: string) {
      if (line.startsWith('fixture:')) processes.push(JSON.parse(line.slice(8)));
    },
  };
  cleanup.push(stopAllKernels);
  return { config, options, processes };
}
async function expectClosed(port: number) {
  await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
}

it('teardown stops a registered kernel even when connection setup throws', async () => {
  const { config, options, processes } = await setup();
  await expect(
    (async () => {
      await startKernel(config, options);
      throw new Error('connect failed');
    })(),
  ).rejects.toThrow('connect failed');
  expect(processes).toHaveLength(1);
  await stopAllKernels();
  await expectClosed(processes[0]!.port);
});

it('startup timeout kills the unready child and releases device listeners', async () => {
  const { config, options, processes } = await setup('unready', 1000);
  await expect(startKernel(config, options)).rejects.toThrow('ready');
  expect(processes).toHaveLength(1);
  await expectClosed(processes[0]!.port);
  const hub = await startDevices(config);
  await hub.close();
});

it('a throwing onReady cannot leak an already ready kernel', async () => {
  const { config, options, processes } = await setup();
  await expect(
    startKernel(config, {
      ...options,
      onReady() {
        throw new Error('observer failed');
      },
    }),
  ).rejects.toThrow('observer failed');
  expect(processes).toHaveLength(1);
  await expectClosed(processes[0]!.port);
});

it('failed restart stops its child, allows rollback restart, then stops everything', async () => {
  const { config, options, processes } = await setup();
  const kernel = await startKernel(config, options);
  options.env.LIFECYCLE_MODE = 'unready';
  await expect(kernel.restart()).rejects.toThrow('ready');
  expect(processes).toHaveLength(2);
  await Promise.all(processes.map(({ port }) => expectClosed(port)));
  options.env.LIFECYCLE_MODE = 'ready';
  await kernel.restart();
  expect(processes).toHaveLength(3);
  await Promise.all([kernel.stop(), kernel.stop()]);
  await Promise.all(processes.map(({ port }) => expectClosed(port)));
});

it('stop serializes behind an in-flight restart and prevents later restarts', async () => {
  const { config, options, processes } = await setup();
  const kernel = await startKernel(config, options);
  options.env.LIFECYCLE_MODE = 'unready';
  const restart = kernel.restart();
  const rejected = expect(restart).rejects.toThrow('ready');
  await expect.poll(() => processes.length).toBe(2);
  await Promise.all([rejected, kernel.stop()]);
  await kernel.restart();
  expect(processes).toHaveLength(2);
  await Promise.all(processes.map(({ port }) => expectClosed(port)));
});
