/**
 * Installs every default npm plugin from the registry into a temporary home and
 * boots the real pinned DSH kernel with them. Opt-in (SWIFTNEST_PLUGINS_E2E=1)
 * because it needs network access and pnpm; CI runs it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startKernel, type RunningKernel } from '../src/kernel.js';
import { installPlugins } from '../src/plugin-install.js';
import { enabledNpmPlugins, enabledPlugins, type DshSource } from '../src/plugins.js';
import { BUNDLES, profileDir } from '../src/profile.js';

const FAILURE = /\b(error|failed|skipping profile bundle)\b/i;

it.skipIf(process.env.SWIFTNEST_PLUGINS_E2E !== '1')(
  'installs the default plugins at their audited versions and boots the kernel with them',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'swiftnest-plugins-e2e-'));
    const log: string[] = [];
    const config = loadConfig(undefined, {
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOME: home,
      SWIFTNEST_PORT: '0',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_MODEL_ID: 'fake',
      // Tool Ultra has its own e2e test; this one covers the npm plugins and the
      // kernel's own market bundle, which is off by default.
      SWIFTNEST_PLUGINS: 'tool-ultra=false,market=true',
    });
    const plugins = enabledNpmPlugins(config.plugins);
    const shipped = enabledPlugins<DshSource>(config.plugins, 'dsh').map((plugin) => plugin.source.package);
    let kernel: RunningKernel | undefined;
    try {
      await installPlugins(config, (line) => log.push(line));
      // Successful registry retries are installation diagnostics, not kernel load failures.
      const startup = log.length;
      kernel = await startKernel(config, { readyTimeoutMs: 90_000, onLine: (line) => log.push(line) });
      // Plugins load after the ready line; give them time to fail loudly.
      await sleep(10_000);
      const alive = kernel.child.exitCode === null;
      await kernel.stop();
      const pkg = JSON.parse(readFileSync(join(profileDir(config), 'package.json'), 'utf8'));
      expect(pkg.dsh.profile.bundles).toEqual([
        ...BUNDLES,
        ...shipped,
        ...plugins.map((plugin) => plugin.source.package),
      ]);
      expect(alive).toBe(true);
      const names = plugins.flatMap((plugin) => [plugin.id, plugin.source.package]);
      expect(
        log.slice(startup).filter((line) => FAILURE.test(line) && names.some((name) => line.includes(name))),
      ).toEqual([]);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.stack : error}\n${log.slice(-80).join('\n')}`, {
        cause: error,
      });
    } finally {
      await kernel?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  300_000,
);
