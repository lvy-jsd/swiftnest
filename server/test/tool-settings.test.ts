import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { ADMIN_TOKEN_ENV, ADMIN_URL_ENV, startDevices } from '../src/devices.js';
import { KernelApply } from '../src/kernel-apply.js';
import { PLUGIN_MANIFEST } from '../src/plugins.js';
import { profileDir, writeProfile } from '../src/profile.js';
import {
  readMcpPresets,
  readToolSettings,
  ToolSettingsManager,
  toolSettingsFile,
  withToolSettings,
} from '../src/tool-settings.js';
import { TOOL_ULTRA_MARKER, TOOL_ULTRA_PACKAGES, TOOL_ULTRA_SOURCE, toolUltraDir } from '../src/tool-ultra.js';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest tool-settings-'));
  homes.push(home);
  const config = loadConfig(undefined, {
    SWIFTNEST_HOME: home,
    SWIFTNEST_LANG: 'en',
    SWIFTNEST_DEVICES_PORT: '0',
    SWIFTNEST_DEVICES_MDNS: 'false',
    SWIFTNEST_PLUGINS: PLUGIN_MANIFEST.plugins
      .filter((p) => p.id !== 'tool-ultra')
      .map((p) => `${p.id}=false`)
      .join(','),
  });
  return { config, home };
}
/** Synthetic vendor, never a second copy of the upstream catalog. */
function fixture(config: ReturnType<typeof loadConfig>, source?: string) {
  const dir = toolUltraDir(config);
  for (const pkg of TOOL_ULTRA_PACKAGES) {
    const path = join(dir, 'packages', `dsh-tool-ultra-${pkg}`);
    mkdirSync(join(path, 'lib'), { recursive: true });
    writeFileSync(join(path, 'lib/index.js'), 'export function apply() {}');
    writeFileSync(join(path, 'cordis.patch.yml'), stringify([{ insert: [{ name: pkg, config: {} }] }]));
  }
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, TOOL_ULTRA_MARKER), TOOL_ULTRA_SOURCE.commit);
  writeFileSync(
    join(dir, 'packages/dsh-tool-ultra-pack-mcp/lib/presets.js'),
    source ??
      `
    export const PRESETS = [
      { id: 'local', title: 'Local fixture', summary: 'Local tools', category: 'test', source: 'fixture', license: 'MIT', defaultOn: true, needs: [], build() { throw Error('must not run'); } },
      { id: 'keyed', title: 'Keyed fixture', summary: 'Keyed tools', category: 'test', source: 'fixture', license: 'MIT', needs: [{env:'SWIFTNEST_TEST_TOOL_KEY', hint:'Get a test key at https://example.test/keys'}] },
      { id: 'folders', title: 'Folders fixture', summary: 'Folder tools', category: 'test', source: 'fixture', license: 'MIT', needs: [{env:'roots', hint:'Choose allowed folders'}] },
    ];`,
  );
}
function manager(config: ReturnType<typeof loadConfig>, restart = vi.fn(async () => {})) {
  return new ToolSettingsManager(config, {
    kernel: new KernelApply({ restart, fail: vi.fn(), log: vi.fn(), lang: 'en' }),
    changed: vi.fn(),
  });
}

describe('tool settings', () => {
  it('atomically saves switches, reads them after reopening and preserves concurrent edits', async () => {
    const { config, home } = setup();
    fixture(config);
    const tools = manager(config);
    await Promise.all([tools.set('local', true), tools.set('keyed', false)]);
    expect(JSON.parse(readFileSync(toolSettingsFile(home), 'utf8')).mcp).toEqual({
      presets: { local: { enabled: true }, keyed: { enabled: false } },
    });
    expect(readToolSettings(home).mcp).toEqual({ presets: { local: { enabled: true }, keyed: { enabled: false } } });
    expect(manager(config).config().mcp?.presets?.local?.enabled).toBe(true);
  });
  it('overlays App switches while retaining YAML-only presets, credentials and roots without mutating YAML', () => {
    const { config } = setup();
    config.mcp = {
      presets: { keyed: { enabled: false, env: { TOKEN: 'secret' }, roots: ['/tmp'] }, folders: { enabled: true } },
    };
    config.capabilities = { packs: { yaml: 'pack:web', replace: 'pack:old' } };
    const merged = withToolSettings(config, {
      mcp: { presets: { keyed: { enabled: true }, local: { enabled: true } } },
      capabilities: { packs: { replace: ['pack:new'] } },
    });
    expect(merged.mcp?.presets).toEqual({
      keyed: { enabled: true, env: { TOKEN: 'secret' }, roots: ['/tmp'] },
      folders: { enabled: true },
      local: { enabled: true },
    });
    expect(merged.capabilities?.packs).toEqual({ yaml: 'pack:web', replace: ['pack:new'] });
    expect(config.mcp.presets?.keyed?.enabled).toBe(false);
  });
  it('degrades to an empty catalog for absent, unbuilt, missing or broken vendor modules', async () => {
    const { config } = setup();
    expect(await readMcpPresets(config)).toEqual([]);
    fixture(config, 'export ! invalid');
    expect(await readMcpPresets(config)).toEqual([]);
    const other = setup().config;
    fixture(other);
    rmSync(join(toolUltraDir(other), 'packages/dsh-tool-ultra-pack-mcp/lib/presets.js'));
    expect(await readMcpPresets(other)).toEqual([]);
    const unbuilt = setup().config;
    fixture(unbuilt);
    rmSync(join(toolUltraDir(unbuilt), TOOL_ULTRA_MARKER));
    expect(await readMcpPresets(unbuilt)).toEqual([]);
  });
  it('defaults off despite upstream defaults, strips executable fields and resolves missing env/roots like planPresets', async () => {
    const { config } = setup();
    fixture(config);
    vi.stubEnv('SWIFTNEST_TEST_TOOL_KEY', 'process-key');
    config.mcp = {
      presets: { keyed: { enabled: true, env: { SWIFTNEST_TEST_TOOL_KEY: ' ' } }, folders: { enabled: true } },
    };
    const tools = manager(config);
    let view = await tools.view('en');
    expect(view.presets[0]).toMatchObject({ enabled: false, state: 'off' });
    expect(view.presets[0]).not.toHaveProperty('defaultOn');
    expect(view.presets[0]).not.toHaveProperty('build');
    expect(view.presets[1]).toMatchObject({
      state: 'needs-key',
      needs: [{ env: 'SWIFTNEST_TEST_TOOL_KEY', hint: expect.stringContaining('https://') }],
    });
    expect(view.presets[2]?.state).toBe('needs-key');
    config.mcp.presets!.keyed!.env = {};
    config.mcp.presets!.folders!.roots = ['/tmp'];
    view = await tools.view('en');
    expect(view.presets.slice(1).map((p) => p.state)).toEqual(['on', 'on']);
    expect(JSON.stringify(view)).not.toContain('process-key');
    await tools.set('keyed', false);
    expect((await tools.view('en')).presets[1]?.state).toBe('off');
  });
  it('removes saved targets and masks YAML on delete, including after reopening; re-adding clears the deletion', async () => {
    const { config, home } = setup();
    config.capabilities = { packs: { research: 'pack:web', keep: 'device:current' } };
    let tools = manager(config);
    await tools.setPack('research', ['pack:media']);
    await tools.deletePack('research');
    expect(readToolSettings(home).capabilities?.packs).not.toHaveProperty('research');
    tools = manager(config);
    expect((await tools.view('en')).packs).toEqual([{ name: 'keep', targets: ['device:current'] }]);
    await tools.setPack('research', 'pack:new');
    expect(tools.config().capabilities?.packs?.research).toBe('pack:new');
    expect(readToolSettings(home).capabilities?.deleted).not.toContain('research');
  });
  it.each(['Bad', '-bad', 'a'.repeat(49), '__proto__'])('rejects invalid bundle name %s', async (name) => {
    await expect(manager(setup().config).setPack(name, 'pack:web')).rejects.toThrow('name');
  });
  it.each([[], '', [' '], [123], null])('rejects empty or invalid targets %j', async (targets) => {
    await expect(manager(setup().config).setPack('valid', targets)).rejects.toThrow('target');
  });
  it('clears pending when switches return to the booted state and only marks successful boots as applied', async () => {
    const { config } = setup();
    fixture(config);
    const tools = manager(config);
    await tools.set('local', true);
    expect((await tools.view('en')).pending).toBe(true);
    await tools.set('local', false);
    expect((await tools.view('en')).pending).toBe(false);
    await tools.set('local', true);
    tools.loaded();
    expect((await tools.view('en')).pending).toBe(false);
  });
  it('rolls back both switches and bundle edits if the kernel cannot start', async () => {
    const { config, home } = setup();
    fixture(config);
    const restart = vi.fn().mockRejectedValueOnce(Error('boot failed')).mockResolvedValue(undefined);
    const tools = manager(config, restart);
    await tools.set('local', true);
    await tools.setPack('new', 'pack:web');
    tools.apply();
    await expect(tools.set('local', false)).rejects.toThrow('already');
    await expect(tools.setPack('another', 'pack:web')).rejects.toThrow('already');
    await vi.waitFor(async () => expect((await tools.view('en')).apply.state).toBe('failed'));
    expect(restart).toHaveBeenCalledTimes(2);
    expect((await tools.view('en')).apply.rolledBack).toBe(true);
    expect(readToolSettings(home).mcp?.presets).toEqual({});
    expect(tools.config().capabilities?.packs).toEqual({});
  });
});

it('routes owner tool operations and carries the App settings through devices.config → writeProfile → toolUltraPatch', async () => {
  const { config, home } = setup();
  fixture(config);
  const restartKernel = vi.fn(async () => {
    hub.tools.loaded();
  });
  const hub = await startDevices(config, { restartKernel, installPlugins: async () => {} });
  const api = (path: string, body?: unknown) =>
    fetch(`${hub.env[ADMIN_URL_ENV]}/swiftnest/api/tools${path}`, {
      method: path ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${hub.env[ADMIN_TOKEN_ENV]}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    expect((await (await api('')).json()).presets).toHaveLength(3);
    expect((await api('/mcp/missing/enable')).status).toBe(404);
    expect((await api('/capability/Bad', { targets: 'pack:web' })).status).toBe(400);
    expect((await api('/capability/good', { targets: [] })).status).toBe(400);
    expect((await api('/mcp/local/enable')).status).toBe(200);
    expect(readToolSettings(home).mcp?.presets?.local?.enabled).toBe(true);
    await api('/mcp/local/disable');
    expect(readToolSettings(home).mcp?.presets?.local?.enabled).toBe(false);
    await api('/mcp/local/enable');
    await api('/mcp/keyed/enable');
    await api('/capability/research', { targets: ['pack:web', 'pack:media'] });
    const view = await (await api('')).json();
    expect(view).toMatchObject({ pending: true, packs: [{ name: 'research', targets: ['pack:web', 'pack:media'] }] });
    expect(view.presets[1]).toMatchObject({ state: 'needs-key', enabled: true });
    writeProfile(hub.config(), { bundleDir: new URL('../bundle/', import.meta.url).pathname, log: vi.fn() });
    const rows = parse(readFileSync(join(profileDir(config), 'cordis.patch.yml'), 'utf8')) as {
      insert?: { name: string; config: unknown }[];
    }[];
    const entries = rows.flatMap((row) => row.insert ?? []);
    expect(entries.find((entry) => entry.name.includes('dsh-tool-ultra-pack-mcp'))?.config).toMatchObject({
      defaults: false,
      presets: { local: { enabled: true }, keyed: { enabled: true } },
    });
    expect(entries.find((entry) => entry.name.includes('dsh-tool-ultra-capability-bridge'))?.config).toMatchObject({
      packs: { research: ['pack:web', 'pack:media'] },
    });
    await api('/capability/research/delete');
    expect(readToolSettings(home).capabilities?.packs).not.toHaveProperty('research');
    expect((await api('/apply')).status).toBe(202);
    expect((await api('/apply')).status).toBe(409);
    expect((await api('/mcp/local/disable')).status).toBe(409);
    await vi.waitFor(() => expect(restartKernel).toHaveBeenCalledOnce());
    expect((await hub.tools.view('en')).pending).toBe(false);
  } finally {
    await hub.close();
  }
});
