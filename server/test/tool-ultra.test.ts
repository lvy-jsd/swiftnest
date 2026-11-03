import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify, parse } from 'yaml';
import { loadConfig } from '../src/config.js';
import { writeProfile } from '../src/profile.js';
import {
  installToolUltra,
  isBuilt,
  toolUltraDir,
  toolUltraPatch,
  TOOL_ULTRA_MARKER,
  TOOL_ULTRA_PACKAGES,
  TOOL_ULTRA_SOURCE,
} from '../src/tool-ultra.js';

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
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-ultra-'));
  homes.push(home);
  const config = loadConfig(undefined, { SWIFTNEST_HOME: home });
  return { home, config, dir: toolUltraDir(config) };
}
function fixture(dir: string) {
  for (const pkg of TOOL_ULTRA_PACKAGES) {
    const packageDir = join(dir, 'packages', `dsh-tool-ultra-${pkg}`);
    mkdirSync(join(packageDir, 'lib'), { recursive: true });
    writeFileSync(join(packageDir, 'lib/index.js'), 'export function apply() {}\n');
    writeFileSync(
      join(packageDir, 'cordis.patch.yml'),
      stringify([
        {
          insert: [
            {
              id: pkg,
              name: `upstream-${pkg}`,
              config: { uniqueDefault: pkg, nested: { enabled: true }, disabled: [] },
            },
          ],
        },
      ]),
    );
  }
}
function fakeCommands(fail?: string, omitBuild = false) {
  spawn.mockImplementation((command: string, args: string[], options: { cwd: string }) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    queueMicrotask(() => {
      expect(isBuilt(options.cwd)).toBe(false);
      if (command === 'git' && args[0] === 'checkout') {
        writeFileSync(join(options.cwd, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
      }
      if (command === 'npm' && args[0] === 'run' && !omitBuild) fixture(options.cwd);
      stdout.end('progress\nlast line');
      stderr.end();
      setImmediate(() => child.emit('close', command === fail ? 1 : 0));
    });
    return child;
  });
}

describe('Tool Ultra', () => {
  it('pins the unpublished source and detects only a matching successful build marker', () => {
    const { dir } = setup();
    expect(TOOL_ULTRA_SOURCE.commit).toBe('8ccfefa1a922ad407e57ecbe6ea8b68e24adcbd9');
    expect(dir).toContain('/vendor/dsh-tool-ultra-8ccfefa1a922');
    fixture(dir);
    expect(isBuilt(dir)).toBe(false);
    writeFileSync(join(dir, TOOL_ULTRA_MARKER), 'wrong commit');
    expect(isBuilt(dir)).toBe(false);
    writeFileSync(join(dir, TOOL_ULTRA_MARKER), TOOL_ULTRA_SOURCE.commit);
    expect(isBuilt(dir)).toBe(true);
  });

  it("uses each package's patch defaults and absolute module paths, without editing its source", () => {
    const { dir } = setup();
    fixture(dir);
    const rows = toolUltraPatch(dir) as { insert: { name: string; config: unknown }[] }[];
    expect(rows).toHaveLength(7);
    rows.forEach((row, i) => {
      const pkg = TOOL_ULTRA_PACKAGES[i];
      const file = join(dir, 'packages', `dsh-tool-ultra-${pkg}`, 'cordis.patch.yml');
      expect(row.insert[0]!.config).toEqual(parse(readFileSync(file, 'utf8'))[0].insert[0].config);
      expect(row.insert[0]!.name).toBe(join(dir, 'packages', `dsh-tool-ultra-${pkg}`, 'lib/index.js'));
      expect(isAbsolute(row.insert[0]!.name)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain(`upstream-${pkg}`);
    });
  });

  it('installs exactly the commit, uses npm ci and build, then becomes a no-op', async () => {
    const { config, dir } = setup();
    fakeCommands();
    const log = vi.fn();
    await installToolUltra(config, log);
    expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['git', ['init']],
      ['git', ['fetch', '--depth', '1', TOOL_ULTRA_SOURCE.repo, TOOL_ULTRA_SOURCE.commit]],
      ['git', ['checkout', '--detach', 'FETCH_HEAD']],
      ['npm', ['ci']],
      ['npm', ['run', 'build']],
    ]);
    expect(spawn.mock.calls[0]![2].env.DSH_APP).toContain('.swiftnest-host');
    expect(log).toHaveBeenCalledWith('progress');
    expect(log).toHaveBeenCalledWith('last line');
    expect(isBuilt(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toMatchObject({
      name: 'fixture',
      private: true,
      overrides: { mathjs: '15.2.0' },
    });
    expect(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).lockfileVersion).toBe(3);
    await installToolUltra(config, log);
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  it.each(['git', 'npm'])('cleans a failed %s install and permits retry', async (command) => {
    const { config, dir } = setup();
    fakeCommands(command);
    await expect(installToolUltra(config, () => {})).rejects.toThrow('failed');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(dir + '.installing')).toBe(false);
    fakeCommands();
    await installToolUltra(config, () => {});
    expect(isBuilt(dir)).toBe(true);
  });

  it('does not mark a build successful when its outputs are missing', async () => {
    const { config, dir } = setup();
    fakeCommands(undefined, true);
    await expect(installToolUltra(config, () => {})).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves another installer's checkout alone", async () => {
    const { config, dir } = setup();
    fixture(dir);
    mkdirSync(dir + '.installing');
    await expect(installToolUltra(config, () => {})).rejects.toThrow('already running');
    expect(existsSync(join(dir, 'packages'))).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('adds built plugins to the generated patch and preserves the final operator patch', () => {
    const { config, dir, home } = setup();
    fixture(dir);
    writeFileSync(join(dir, TOOL_ULTRA_MARKER), TOOL_ULTRA_SOURCE.commit);
    const opts = { bundleDir: home, log: vi.fn() };
    const profile = writeProfile(config, opts);
    const user = join(profile, 'user.patch.yml');
    writeFileSync(user, '- id: core\n  config: { pinned: [mine] }\n');
    writeProfile(config, opts);
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toContain(
      join(dir, 'packages/dsh-tool-ultra-core/lib/index.js'),
    );
    expect(readFileSync(user, 'utf8')).toContain('pinned: [mine]');
    expect(opts.log).not.toHaveBeenCalled();
    config.toolUltra = false;
    writeProfile(config, opts);
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).not.toContain('dsh-tool-ultra');
  });

  it.each(['zh-CN', 'en'] as const)(
    'starts without installing and prints a %s hint when the build is absent',
    (lang) => {
      const { config, home } = setup();
      config.lang = lang;
      const log = vi.fn();
      const profile = writeProfile(config, { bundleDir: home, log });
      expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).not.toContain('dsh-tool-ultra');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('swiftnest-server tools install'));
      expect(log.mock.calls[0]![0]).toContain(lang === 'en' ? 'not built' : '尚未构建');
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
