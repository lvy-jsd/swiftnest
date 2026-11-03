import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { installPlugins, verifyIntegrity } from '../src/plugin-install.js';
import {
  checkManifest,
  enabledNpmPlugins,
  type NpmSource,
  PLUGIN_MANIFEST,
  type Plugin,
  type PluginManifest,
} from '../src/plugins.js';
import { profilePlugins } from '../src/profile-plugins.js';
import { BUNDLES, profileDir, writeProfile } from '../src/profile.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn,
}));

const homes: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(plugins = 'tool-ultra=false') {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-plugins-'));
  homes.push(home);
  const config = loadConfig(undefined, { SWIFTNEST_LANG: 'en', SWIFTNEST_HOME: home, SWIFTNEST_PLUGINS: plugins });
  return { home, config, profile: profileDir(config) };
}

function install(profile: string, plugin: Plugin<NpmSource>, version = plugin.source.version) {
  const dir = join(profile, 'node_modules', plugin.source.package);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: plugin.source.package, version }));
}

function lockFor(plugins: Plugin<NpmSource>[], integrity?: string) {
  const packages = Object.fromEntries(
    plugins.map(({ source }) => [
      `${source.package}@${source.version}`,
      { resolution: { integrity: integrity ?? source.integrity } },
    ]),
  );
  return stringify({ lockfileVersion: '9.0', packages });
}

const npmPlugin = (manifest: PluginManifest) => manifest.plugins.find((plugin) => plugin.source.type === 'npm')!;
const copy = (): PluginManifest => structuredClone(PLUGIN_MANIFEST);

describe('plugin manifest', () => {
  it('pins every plugin to an allowed license and an exact source', () => {
    expect(checkManifest(copy())).toEqual(PLUGIN_MANIFEST);
    expect(PLUGIN_MANIFEST.allowedLicenses).toEqual(['MIT', 'Apache-2.0', 'BSD-3-Clause']);
  });

  it('keeps integrations that send data or need credentials off, with a reason', () => {
    for (const id of ['vision-router', 'im']) {
      const plugin = PLUGIN_MANIFEST.plugins.find((candidate) => candidate.id === id)!;
      expect(plugin.enabled).toBe(false);
      expect(plugin.reason).toBeTruthy();
    }
  });

  it.each<[string, (manifest: PluginManifest) => void]>([
    ['a version range', (m) => Object.assign(npmPlugin(m).source, { version: '^2.7.2' })],
    ['missing integrity', (m) => Object.assign(npmPlugin(m).source, { integrity: '' })],
    ['a short commit', (m) => Object.assign(m.plugins[0]!.source, { commit: '8ccfefa' })],
    ['no packages to build', (m) => Object.assign(m.plugins[0]!.source, { packages: [] })],
    ['a disallowed license', (m) => Object.assign(npmPlugin(m), { license: 'AGPL-3.0' })],
    ['a duplicate id', (m) => m.plugins.push(structuredClone(m.plugins[0]!))],
  ])('rejects %s', (_, mutate) => {
    const manifest = copy();
    mutate(manifest);
    expect(() => checkManifest(manifest)).toThrow();
  });
});

describe('profile plugins', () => {
  it('declares enabled npm plugins at exact versions and loads only the installed ones', () => {
    const { config, profile } = setup();
    const [first, second] = enabledNpmPlugins(config.plugins);
    install(profile, first!);
    install(profile, second!, '0.0.1');
    const plugins = profilePlugins(config, profile);
    expect(plugins.dependencies[first!.source.package]).toBe(first!.source.version);
    expect(plugins.bundles).toEqual([first!.source.package]);
    expect(plugins.missing).toContain(second!.id);
    expect(plugins.missing).not.toContain('vision-router');
    expect(plugins.rows).toEqual([]);
  });

  it('leaves out disabled plugins and enables opt-in ones on request', () => {
    const { config, profile } = setup('tool-ultra=false,safety-net=false,im=true');
    const plugins = profilePlugins(config, profile);
    expect(plugins.dependencies).not.toHaveProperty('cc-safety-net');
    expect(plugins.dependencies['@xmanrui/dsh-im']).toBe('5.9.1');
  });

  it('writes installed plugins after the built-in bundles and denies dependency build scripts', () => {
    const { config, home, profile } = setup();
    const [first] = enabledNpmPlugins(config.plugins);
    install(profile, first!);
    const log = vi.fn();
    writeProfile(config, { bundleDir: home, log });
    const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    expect(pkg.dsh.profile.bundles).toEqual([...BUNDLES, first!.source.package]);
    expect(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')).toContain('strictDepBuilds: false');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('swiftnest-server plugins install'));
  });
});

describe('integrity check', () => {
  const plugins = enabledNpmPlugins({});

  it('accepts exactly the audited tarballs', () => {
    const { profile } = setup();
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'pnpm-lock.yaml'), lockFor(plugins));
    expect(() => verifyIntegrity(profile, plugins)).not.toThrow();
  });

  it.each([
    ['a different tarball', `sha512-${'A'.repeat(86)}==`],
    ['a missing entry', undefined],
  ])('rejects %s', (_, integrity) => {
    const { profile } = setup();
    mkdirSync(profile, { recursive: true });
    const locked = integrity ? lockFor(plugins, integrity) : lockFor(plugins.slice(1));
    writeFileSync(join(profile, 'pnpm-lock.yaml'), locked);
    expect(() => verifyIntegrity(profile, plugins)).toThrow('integrity mismatch');
  });
});

function fakeInstall(code = 0) {
  spawn.mockImplementation((_command: string, _args: string[], options: { cwd: string }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      writeFileSync(join(options.cwd, 'pnpm-lock.yaml'), lockFor(enabledNpmPlugins({ 'tool-ultra': false })));
      child.stdout.end('installed\n');
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  });
}

describe('installPlugins', () => {
  it("installs through DSH's package command in the profile, then verifies integrity", async () => {
    const { config, profile } = setup();
    fakeInstall();
    const log = vi.fn();
    await installPlugins(config, log);
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['plugin', '--profile', 'swiftnest', 'install']);
    expect(options.cwd).toBe(profile);
    expect(options.env.DSH_HOME).toBe(join(config.home, 'dsh'));
    expect(log).toHaveBeenCalledWith('installed');
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Restart Swiftnest Server'));
  });

  it('reports a failed installation', async () => {
    const { config } = setup();
    fakeInstall(1);
    await expect(installPlugins(config, () => {})).rejects.toThrow('failed (exit 1)');
  });

  it('runs nothing when every plugin is disabled', async () => {
    const off = PLUGIN_MANIFEST.plugins.map((plugin) => `${plugin.id}=false`).join(',');
    const { config } = setup(off);
    await installPlugins(config, () => {});
    expect(spawn).not.toHaveBeenCalled();
  });
});
