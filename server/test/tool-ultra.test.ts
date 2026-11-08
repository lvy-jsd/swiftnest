import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/config.js';
import { writeProfile } from '../src/profile.js';
import { PLUGIN_MANIFEST, enabledNpmPlugins } from '../src/plugins.js';
import { isBuilt, toolUltraDir, toolUltraPatch, TOOL_ULTRA_PACKAGES } from '../src/tool-ultra.js';
import { toolUltraPackages } from './fixtures/tool-ultra-packages.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest ultra npm-'));
  homes.push(home);
  const config = loadConfig(undefined, {
    SWIFTNEST_HOME: home,
    SWIFTNEST_PLUGINS: PLUGIN_MANIFEST.plugins
      .filter((plugin) => plugin.id !== 'tool-ultra')
      .map(({ id }) => `${id}=false`)
      .join(','),
  });
  return { home, config, dir: toolUltraDir(config) };
}

describe('Tool Ultra published group', () => {
  it('pins all twelve current packages to 0.5.0 under a single switch', () => {
    const { config, dir } = setup();
    expect(TOOL_ULTRA_PACKAGES).toHaveLength(12);
    expect(TOOL_ULTRA_PACKAGES.every((pkg) => pkg.version === '0.5.0')).toBe(true);
    expect(enabledNpmPlugins(config.plugins).map(({ source }) => source.package)).toEqual(
      TOOL_ULTRA_PACKAGES.map((pkg) => pkg.package),
    );
    expect(dir).not.toContain('vendor');
    expect(isBuilt(dir)).toBe(false);
    toolUltraPackages(dir);
    expect(isBuilt(dir)).toBe(true);
    config.plugins['tool-ultra'] = false;
    expect(enabledNpmPlugins(config.plugins)).toEqual([]);
  });

  it.each(['version', 'integrity', 'entry', 'module', 'patch'])('rejects an incomplete group with mismatching %s', (kind) => {
    const { dir } = setup();
    toolUltraPackages(dir);
    const pkg = TOOL_ULTRA_PACKAGES[0]!;
    if (kind === 'version')
      writeFileSync(join(dir, 'node_modules', pkg.package, 'package.json'), '{"version":"0.0.1"}');
    if (kind === 'integrity') writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages: {}');
    if (kind === 'entry') rmSync(join(dir, 'node_modules', pkg.package, 'package.json'));
    if (kind === 'module') rmSync(join(dir, 'node_modules', pkg.package, 'lib/index.js'));
    if (kind === 'patch') rmSync(join(dir, 'node_modules', pkg.package, 'cordis.patch.yml'));
    expect(isBuilt(dir)).toBe(false);
  });

  it('uses each published package patch without changing its defaults or source', () => {
    const { dir } = setup();
    toolUltraPackages(dir);
    const rows = toolUltraPatch(dir) as { insert: { name: string; config: unknown }[] }[];
    expect(rows).toHaveLength(12);
    rows.forEach((row, i) => {
      const pkg = TOOL_ULTRA_PACKAGES[i]!;
      const file = join(dir, 'node_modules', pkg.package, 'cordis.patch.yml');
      expect(row.insert[0]!.config).toEqual(parse(readFileSync(file, 'utf8'))[0].insert[0].config);
      expect(row.insert[0]!.name).toBe(join(dir, 'node_modules', pkg.package, 'lib/index.js'));
      expect(isAbsolute(row.insert[0]!.name)).toBe(true);
    });
  });

  it('retains media isolation, default-off MCP, and owner capability configuration', () => {
    const { config, dir, home } = setup();
    toolUltraPackages(dir);
    config.mcp = { presets: { memory: { enabled: true } } };
    config.capabilities = { packs: { workstation: 'device:current' } };
    const rows = toolUltraPatch(dir, config) as { insert: { name: string; config: Record<string, unknown> }[] }[];
    const entries = rows.flatMap((row) => row.insert);
    expect(entries.find((entry) => entry.name.includes('pack-mcp'))?.config).toMatchObject({
      defaults: false,
      presets: config.mcp.presets,
    });
    expect(entries.find((entry) => entry.name.includes('capability-bridge'))?.config.packs).toEqual(
      config.capabilities.packs,
    );
    expect(entries.find((entry) => entry.name === '@swiftnest/server-bundle/media')?.config).toMatchObject({
      sourceModule: join(dir, 'node_modules/@lvy-jsd/dsh-tool-ultra-pack-media/lib/index.js'),
      outputDir: join(home, 'files/media'),
      geminiUploads: false,
    });
  });

  it('loads one complete group, preserves user patches and never treats disabled members as market installs', () => {
    const { config, dir, home } = setup();
    toolUltraPackages(dir);
    const opts = { bundleDir: home, log: vi.fn() };
    writeProfile(config, opts);
    const user = join(dir, 'user.patch.yml');
    writeFileSync(user, '- id: core\n  config: { pinned: [mine] }\n');
    const { plugins } = writeProfile(config, opts);
    expect(plugins.loaded).toEqual(['tool-ultra']);
    expect(Object.keys(plugins.dependencies)).toHaveLength(12);
    expect(plugins.bundles).toEqual([]);
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('dsh-tool-ultra-core');
    expect(readFileSync(user, 'utf8')).toContain('pinned: [mine]');
    config.plugins['tool-ultra'] = false;
    expect(writeProfile(config, opts).plugins).toMatchObject({ loaded: [], rows: [], unaudited: [] });
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).not.toContain('dsh-tool-ultra');
  });
});
