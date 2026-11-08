/** Opt in: real pinned source, fonts, ffmpeg and local sherpa-onnx. No model API. */
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  mediaHarness,
  execute,
  svg,
  htmlScene,
  voiceFixture,
  speakerFixture,
  type MediaHarness,
} from './fixtures/media-harness.js';
import { FileStorage } from '../src/file-storage.js';
import { mediaFiles } from '../bundle/src/media-files.js';
import { toolUltraPatch } from '../src/tool-ultra.js';
import { mapEvent } from '../../packages/api/src/events.js';
import { chatReducer, emptyChat } from '../../client/src/chat.js';

describe.skipIf(process.env.SWIFTNEST_MEDIA_E2E !== '1')('real media pack', () => {
  let h: MediaHarness;
  let voice: string;
  let clip: string;
  beforeAll(async () => {
    h = await mediaHarness();
    ({ voice, clip } = await voiceFixture(h));
  }, 600_000);
  afterAll(async () => {
    await h?.close();
  });
  it('registers the default media pack and seven tools, including HTML', () => {
    const rows = toolUltraPatch(h.dir, h.config) as any[];
    expect(rows.at(-1).insert[0].config).toMatchObject({ speechModel: 'sensevoice', speechThreads: 4 });
    expect(h.packs[0].id).toBe('media');
    expect([...h.tools.keys()]).toEqual([
      'html_render',
      'svg_render',
      'chart_render',
      'music_render',
      'video_render',
      'audio_transcribe',
      'video_understand',
    ]);
  });
  it('renders HTML/CSS with Chinese and emoji, and real animated WebP/GIF attachments', async () => {
    const tool = h.tools.get('html_render');
    const still = await tool.execute({ html: htmlScene('中文海报 🌻'), width: 320, height: 480 }, {});
    expect(await h.sharp(join(h.inputDir, still.mediaFiles[0].path)).metadata()).toMatchObject({
      format: 'png',
      width: 320,
      height: 480,
    });
    for (const format of ['webp', 'gif']) {
      const moving = await tool.execute(
        { html: htmlScene('动起来 🌻'), width: 160, height: 240, seconds: 0.5, format },
        {},
      );
      expect(moving.mediaFiles[0].path).toMatch(new RegExp(`\\.${format}$`));
      const animation = h.sharp(join(h.inputDir, moving.mediaFiles[0].path), { animated: true });
      expect((await animation.metadata()).pages).toBeGreaterThan(1);
    }
  }, 60_000);
  it('refuses scripts, web fonts, external links and private HTML images', async () => {
    const forbidden = [
      '<script>alert(1)</script>',
      '<style>@font-face {font-family: remote; src: url(https://example.com/font.woff2)}</style>',
      '<img src="https://example.com/image.png">',
      `<img src="${join(h.home, 'private.png')}">`,
    ];
    for (const html of forbidden) {
      await expect(h.tools.get('html_render').execute({ html, width: 320, height: 480 }, {})).rejects.toThrow();
    }
  });
  it('renders distinct Chinese title glyphs instead of missing-glyph boxes', async () => {
    const first = await renderChart(h, '中文');
    const second = await renderChart(h, '天地');
    const missing = await renderChart(h, '\u0378\u0378');
    // Same two-character titles, fixed layout. Compare only the title strip, so
    // bars/axes cannot satisfy the check. Distinct glyphs must differ from each
    // other and from two unassigned Unicode codepoints (fontconfig's tofu).
    const strips = await Promise.all([first, second, missing].map((file) => titlePixels(h, file)));
    expect(strips[0].equals(strips[1])).toBe(false);
    expect(strips[0].equals(strips[2])).toBe(false);
    expect(strips[1].equals(strips[2])).toBe(false);
    expect(strips[0].some((pixel: number) => pixel < 120)).toBe(true);
  });
  it('makes MIDI/WAV and a playable five-second MP4 with its soundtrack', async () => {
    const music = await h.tools.get('music_render').execute({ tracks: [{ notes: 'C4:1 E4:1 G4:2' }] }, {});
    expect(music.mediaFiles.map((f: any) => f.name.split('.').at(-1))).toEqual(['mid', 'wav']);
    const audio = music.mediaFiles.find((f: any) => f.name.endsWith('.wav')).name;
    const video = await h.tools
      .get('video_render')
      .execute({ scenes: [{ svg, seconds: 5 }], width: 320, height: 180, audio }, {});
    const path = join(h.inputDir, video.mediaFiles[0].path);
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
    const info = JSON.parse(stdout);
    expect(Number(info.format.duration)).toBeCloseTo(5, 0);
    expect(info.streams.some((s: any) => s.codec_type === 'video')).toBe(true);
    expect(info.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
    await execute('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-']);
  }, 60_000);
  it('still makes playable music offline and explains the built-in synthesizer fallback', async () => {
    const { musicTool, resolveSettings } = await import(
      pathToFileURL(join(h.dir, 'node_modules/@lvy-jsd/dsh-tool-ultra-pack-media/lib/index.js')).href
    );
    const tool = musicTool(resolveSettings({ outputDir: h.outputDir }), {
      soundFont: async () => {
        throw new Error('offline fixture');
      },
    });
    const text = await tool.execute({ tracks: [{ notes: 'C4:1 E4:1 G4:2' }] });
    expect(text).toContain('built-in synth, because the SoundFont could not load: offline fixture');
    const files = await mediaFiles(text, h.outputDir);
    expect(files.map((f) => f.name.split('.').at(-1))).toEqual(['mid', 'wav']);
    const audio = files.find((f) => f.name.endsWith('.wav'))!;
    await execute('ffmpeg', ['-v', 'error', '-i', join(h.inputDir, audio.path), '-f', 'null', '-']);
  });
  it('makes a 1080×1920 phone video from two HTML scenes with pop captions and generated music', async () => {
    const music = await h.tools.get('music_render').execute({ tracks: [{ notes: 'C4:1 E4:1 G4:2' }] }, {});
    expect(music.text).toMatch(/SoundFont|built-in synth, because/);
    const audio = music.mediaFiles.find((f: any) => f.name.endsWith('.wav')).name;
    const video = await h.tools.get('video_render').execute(
      {
        scenes: [
          { html: htmlScene('你好，世界 🌻'), seconds: 1.5 },
          { html: htmlScene('把灵感带走 ✨', '#284d82'), seconds: 1.5 },
        ],
        width: 1080,
        height: 1920,
        fps: 24,
        transition: 'slide-left',
        captionStyle: 'pop',
        captions: [
          { start: 0.2, end: 1.3, text: '第一幕' },
          { start: 1.7, end: 2.8, text: '第二幕' },
        ],
        audio,
      },
      {},
    );
    const path = join(h.inputDir, video.mediaFiles[0].path);
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
    const info = JSON.parse(stdout);
    expect(info.streams.find((s: any) => s.codec_type === 'video')).toMatchObject({
      width: 1080,
      height: 1920,
      r_frame_rate: '24/1',
    });
    expect(Number(info.format.duration)).toBeCloseTo(3, 1);
    expect(Number(info.format.size)).toBeGreaterThan(1000);
    expect(info.streams.find((s: any) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' });
    await execute('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-']);
  }, 180_000);
  it('denies private inputs and symlinks escaping the upload area', async () => {
    const outside = join(h.home, 'private.wav');
    await writeFile(outside, await readFile(voice));
    const escaped = join(h.inputDir, 'escape.wav');
    await symlink(outside, escaped);
    for (const file of [outside, escaped]) {
      await expect(h.tools.get('audio_transcribe').execute({ file }, {})).rejects.toThrow('not inside');
    }
  });
  it('transcribes with SenseVoice, preserving speaker labels in SRT, chat and text-only model output', async () => {
    const result = await h.tools.get('audio_transcribe').execute({ file: voice, language: 'en' }, {});
    expect(result.text).toContain('local model SenseVoice Small');
    expect(result.text).toMatch(/speech|recognition|quick|brown/i);
    expect(result.text).toMatch(/\d{2}:\d{2}/);
    const subtitles = result.mediaFiles.find((f: any) => f.name.endsWith('.srt'));
    expect(await readFile(join(h.inputDir, subtitles.path), 'utf8')).toMatch(/\d{2}:\d{2}:\d{2},\d{3} -->/);
    await verifySpeakers(h);
    const fast = await h.tools.get('audio_transcribe').execute({ file: voice, language: 'en', speakers: false }, {});
    expect(fast.text).toContain('local model SenseVoice Small');
    expect(fast.text).toMatch(/speech|recognition|quick|brown/i);
    expect(fast.text).not.toMatch(/Speaker \d+:/);
  }, 600_000);
  it('understands an uploaded clip with facts, timestamped storyboard and transcript, keeping model output text-only', async () => {
    const tool = h.tools.get('video_understand');
    const result = await tool.execute({ file: clip, frames: 4, language: 'en' }, {});
    expect(result.text).toMatch(/320×180.*with sound/);
    expect(result.text).toMatch(/Storyboard \(4 frames/);
    expect(result.text).toContain('No scene changes found; frames are evenly spaced.');
    expect(result.text).toMatch(/Speech \(SenseVoice Small/);
    expect(result.text).toMatch(/speech|recognition|quick|brown/i);
    const storyboard = result.mediaFiles.find((f: any) => f.name.endsWith('.jpg'));
    const storage = new FileStorage(h.inputDir, join(h.home, 'receipts'), 'test', 1024 ** 3);
    const image = await storage.allowed(storyboard.path);
    expect((await h.sharp(image).metadata()).format).toBe('jpeg');
    expect(tool.output.render({}, result).map((block: any) => block.type)).toEqual(['text']);
    await verifyCutStoryboard(h);
  }, 600_000);
});
async function cutFixture(h: MediaHarness): Promise<string> {
  const file = join(h.inputDir, 'cuts.mp4');
  await execute('ffmpeg', [
    '-y',
    '-v',
    'error',
    ...['red:d=1', 'blue:d=0.5', 'white:d=2.5'].flatMap((scene) => [
      '-f',
      'lavfi',
      '-i',
      `color=c=${scene}:s=320x180:r=24`,
    ]),
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  return file;
}
async function verifyCutStoryboard(h: MediaHarness): Promise<void> {
  const file = await cutFixture(h);
  const tool = h.tools.get('video_understand');
  const result = await tool.execute({ file, frames: 4, transcript: false }, {});
  expect(result.text).toContain('3 shots; the scene changes at 1.0 s, 1.5 s.');
  expect(result.text).toContain('Storyboard (4 frames, at least one per shot');
  expect(result.text).not.toContain('Speech (');
  const storyboard = result.mediaFiles.find((entry: any) => entry.name.endsWith('.jpg'));
  const image = join(h.inputDir, storyboard.path);
  expect(await h.sharp(image).metadata()).toMatchObject({ format: 'jpeg', width: 1280, height: 180 });
  for (const [index, rgb] of [
    [255, 0, 0],
    [0, 0, 255],
    [255, 255, 255],
    [255, 255, 255],
  ].entries()) {
    const pixel = await h
      .sharp(image)
      .extract({ left: index * 320 + 160, top: 60, width: 1, height: 1 })
      .raw()
      .toBuffer();
    rgb.forEach((value, channel) => {
      expect(Math.abs(pixel[channel] - value)).toBeLessThan(15);
    });
  }
  expect(tool.output.render({}, result)).toEqual([{ type: 'text', text: result.text }]);
}
async function renderChart(h: MediaHarness, title: string): Promise<string> {
  const result = await h.tools.get('chart_render').execute(
    {
      spec: {
        title: { text: title, anchor: 'start', fontSize: 30, offset: 10 },
        width: 320,
        height: 180,
        data: {
          values: [
            { x: 'A', y: 2 },
            { x: 'B', y: 3 },
          ],
        },
        mark: 'bar',
        encoding: { x: { field: 'x', type: 'nominal' }, y: { field: 'y', type: 'quantitative' } },
      },
    },
    {},
  );
  return join(h.inputDir, result.mediaFiles[0].path);
}
async function titlePixels(h: MediaHarness, file: string): Promise<Buffer> {
  const metadata = await h.sharp(file).metadata();
  return h
    .sharp(file)
    .extract({ left: 0, top: 0, width: metadata.width, height: 38 })
    .flatten({ background: '#fff' })
    .raw()
    .toBuffer();
}

async function verifySpeakers(h: MediaHarness): Promise<void> {
  const tool = h.tools.get('audio_transcribe');
  const result = await tool.execute({ file: await speakerFixture(h), language: 'zh' }, {});
  expect(result.text).toMatch(/[3-5] speakers/);
  expect(result.text).toContain('Speaker 1:');
  expect(result.text).toContain('Speaker 2:');
  expect(result.text).toContain('雷军');
  const subtitles = result.mediaFiles.find((file: any) => file.name.endsWith('.srt'));
  const srt = await readFile(join(h.inputDir, subtitles.path), 'utf8');
  expect(srt).toContain('Speaker 1:');
  expect(srt).toContain('Speaker 2:');
  expect(tool.output.render({}, result)).toEqual([{ type: 'text', text: result.text }]);
  const [event] = mapEvent('speech', {
    type: 'tool/result',
    seq: 2,
    time: 0,
    data: {
      message: { toolCallId: 'speech', content: tool.output.render({}, result) },
      meta: tool.output.presentationMeta({}, result),
    },
  });
  expect(event).toMatchObject({ type: 'tool-result', text: result.text });
  const state = chatReducer(emptyChat(), event!);
  expect(state.rows[0]).toMatchObject({ kind: 'tools', calls: { speech: { text: result.text } } });
}
