import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { TOOL_ULTRA_PACKAGES, toolUltraPatch } from '../src/tool-ultra.js';
import { isEnabled, pluginById } from '../src/plugins.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each(['zh-CN', 'en'] as const)('enables media with Tool Ultra and forwards the %s server language', async (lang) => {
  const root = await mkdtemp(join(tmpdir(), 'swiftnest-media-config-'));
  roots.push(root);
  for (const pkg of TOOL_ULTRA_PACKAGES) {
    const dir = join(root, 'node_modules', pkg.package);
    await mkdir(join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'lib/index.js'), 'export function apply() {}');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: pkg.package,
        version: pkg.version,
        exports: { '.': './lib/index.js', './package.json': './package.json' },
      }),
    );
    await writeFile(
      join(dir, 'cordis.patch.yml'),
      stringify([
        {
          insert: [
            {
              name: pkg.package,
              config: { maxPixels: 16777216, disable: [], speechModel: 'sensevoice', speechThreads: 4 },
            },
          ],
        },
      ]),
    );
  }
  const config = loadConfig(undefined, { SWIFTNEST_HOME: root, SWIFTNEST_LANG: lang });
  expect(isEnabled(pluginById('tool-ultra', 'npm-group'), config.plugins)).toBe(true);
  const rows = toolUltraPatch(root, config) as any[];
  const entry = rows.at(-1).insert[0];
  expect(entry.name).toBe('@swiftnest/server-bundle/media');
  expect(entry.config).toEqual({
    maxPixels: 16777216,
    disable: [],
    speechModel: 'sensevoice',
    speechThreads: 4,
    sourceModule: join(root, 'node_modules/@lvy-jsd/dsh-tool-ultra-pack-media/lib/index.js'),
    outputDir: join(root, 'files/media'),
    inputDirs: [join(root, 'files')],
    modelCacheDir: join(root, 'models'),
    lang,
    modelMirror: undefined,
    geminiUploads: false,
    geminiKeyFile: join(root, 'media-gemini.key'),
  });
  expect(
    await readFile(join(root, 'node_modules/@lvy-jsd/dsh-tool-ultra-pack-media/cordis.patch.yml'), 'utf8'),
  ).not.toContain('outputDir');
  config.media = {
    modelMirror: 'https://models.example/releases/',
    soundfont: '/srv/instruments.sf3',
    geminiUploads: true,
    soundfontUrl: 'https://sounds.example/FluidR3Mono_GM.sf3',
  };
  const overridden = (toolUltraPatch(root, config) as any[]).at(-1).insert[0].config;
  expect(overridden).toMatchObject(config.media);
  expect(overridden).not.toHaveProperty('geminiApiKey');
  expect(overridden).not.toHaveProperty('geminiModel');
});
it('accepts an operator speech mirror and refuses invalid URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swiftnest-media-host-'));
  roots.push(root);
  const file = join(root, 'config.yaml');
  await writeFile(file, 'media:\n  modelMirror: https://models.example/\n');
  expect(loadConfig(file, {}).media?.modelMirror).toBe('https://models.example/');
  for (const url of [
    'file:///etc/',
    'http://models.example/',
    'https://user:pass@models.example/',
    'https://models.example/?q=1',
  ]) {
    await writeFile(file, stringify({ media: { modelMirror: url } }));
    expect(() => loadConfig(file, {})).toThrow('HTTPS');
  }
});
it('accepts an optional instrument library or HTTPS mirror and refuses unsafe download URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swiftnest-media-soundfont-'));
  roots.push(root);
  const file = join(root, 'config.yaml');
  await writeFile(file, 'media:\n  soundfont: /srv/music.sf3\n  soundfontUrl: https://sounds.example/library.sf3\n');
  expect(loadConfig(file, {}).media).toEqual({
    soundfont: '/srv/music.sf3',
    soundfontUrl: 'https://sounds.example/library.sf3',
  });
  for (const url of ['file:///etc/passwd', 'http://sounds.example/', 'https://user:pass@sounds.example/']) {
    await writeFile(file, stringify({ media: { soundfontUrl: url } }));
    expect(() => loadConfig(file, {})).toThrow('HTTPS');
  }
  await writeFile(file, 'media:\n  soundfont: 12\n');
  expect(() => loadConfig(file, {})).toThrow('path');
});
