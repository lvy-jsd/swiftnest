import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mediaFiles } from '../src/media-files.js';
import { modelMirror, requireMediaPrograms } from '../src/media-runtime.js';
import { adaptTool } from '../src/media.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('uses sherpa releases, chooses the Chinese mirror, falls back and preserves overrides', async () => {
  const releases = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/';
  const mirror = `https://gh-proxy.com/${releases}`;
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  expect(await modelMirror('zh-CN', releases, undefined, fetcher)).toBe(mirror);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await modelMirror('en', releases, undefined, fetcher)).toBe(releases);
  expect(fetcher).toHaveBeenCalledWith(`${releases}asr-models/silero_vad.onnx`, {
    method: 'HEAD',
    signal: expect.any(AbortSignal),
  });
  fetcher.mockResolvedValue({ ok: false });
  expect(await modelMirror('en', releases, undefined, fetcher)).toBe(mirror);
  fetcher.mockRejectedValue(new Error('offline'));
  expect(await modelMirror('en', releases, undefined, fetcher)).toBe(mirror);
  fetcher.mockClear();
  expect(await modelMirror('zh-CN', releases, 'https://models.example/releases', fetcher)).toBe(
    'https://models.example/releases/',
  );
  expect(await modelMirror('zh-CN', releases, releases, fetcher)).toBe(releases);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['en', 'zh-CN'] as const)(
  'missing ffmpeg gives a plain %s catalog message without breaking other tools',
  async (lang) => {
    vi.stubEnv('PATH', '/nonexistent-swiftnest-programs');
    await expect(requireMediaPrograms('audio_transcribe', {}, lang)).rejects.toThrow(
      lang === 'en' ? 'Install ffmpeg' : '安装 ffmpeg',
    );
    await expect(requireMediaPrograms('svg_render', {}, lang)).resolves.toBeUndefined();
  },
);
it('checks missing Chinese fonts for HTML as well as SVG/chart tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swiftnest-media-fonts-'));
  roots.push(root);
  const match = join(root, 'fc-match');
  await writeFile(match, '#!/bin/sh\nprintf en\n', { mode: 0o700 });
  vi.stubEnv('PATH', root);
  for (const name of ['html_render', 'svg_render', 'chart_render']) {
    await expect(requireMediaPrograms(name, { text: '中文' }, 'zh-CN')).rejects.toThrow('中文字体');
    await expect(requireMediaPrograms(name, { text: 'English' }, 'en')).resolves.toBeUndefined();
  }
  await writeFile(match, '#!/bin/sh\nprintf "en|zh-cn"\n');
  await expect(requireMediaPrograms('html_render', { text: '中文' }, 'en')).resolves.toBeUndefined();
});
it('exposes only regular generated files inside the output folder, refusing escaped links and forged paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swiftnest-media-files-'));
  roots.push(root);
  const output = join(root, 'media');
  await mkdir(output);
  await writeFile(join(output, '图表.png'), 'pixels');
  await writeFile(join(output, 'animation.gif'), 'frames');
  await writeFile(join(root, 'private.png'), 'private');
  await symlink(join(root, 'private.png'), join(output, 'escape.png'));
  expect(
    await mediaFiles(
      `${output}/图表.png\n${output}/animation.gif\n${output}/escape.png\n${output}/../private.png\n${root}/private.png`,
      output,
    ),
  ).toEqual([
    { path: 'media/图表.png', name: '图表.png' },
    { path: 'media/animation.gif', name: 'animation.gif' },
  ]);
});
it('keeps media output as text for the model and persists separate App attachment metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swiftnest-media-adapter-'));
  roots.push(root);
  await writeFile(join(root, 'storyboard.jpg'), 'image');
  const tool = adaptTool(
    {
      name: 'svg_render',
      output: {},
      execute: async () =>
        `Facts and transcript\n[00:01-00:03] Speaker 1: Hello.\n[00:03-00:05] Speaker 2: Hi.\n${root}/storyboard.jpg`,
    },
    {
      sourceModule: '',
      outputDir: root,
      inputDirs: [],
      modelCacheDir: root,
      lang: 'en',
    },
  ) as any;
  const result = await tool.execute({}, {});
  expect(result.text).toContain('Speaker 1: Hello.');
  expect(result.text).toContain('Speaker 2: Hi.');
  expect(tool.output.render({}, result)).toEqual([{ type: 'text', text: result.text }]);
  expect(tool.output.presentationMeta({}, result)).toEqual({
    mediaFiles: [{ path: 'media/storyboard.jpg', name: 'storyboard.jpg' }],
  });
});
