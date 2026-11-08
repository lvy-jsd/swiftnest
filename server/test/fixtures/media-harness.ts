import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apply } from '../../bundle/src/media.js';
import { loadConfig } from '../../src/config.js';
import { installToolUltra, toolUltraDir, isBuilt, toolUltraModule } from '../../src/tool-ultra.js';
import { PLUGIN_MANIFEST } from '../../src/plugins.js';

export const execute = promisify(execFile);

export function mediaContext(tools: Map<string, any>, packs: any[]): any {
  const ctx: any = {
    tools: { register: (tool: any) => tools.set(tool.name, tool) },
    toolCatalog: {
      registerToolPack: (pack: any) => {
        packs.push(pack);
        return () => {};
      },
    },
    inject: (_deps: string[], callback: (context: any) => void) => callback(ctx),
    effect: (fn: () => unknown) => fn(),
  };
  return ctx;
}

export async function mediaHarness() {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-media-e2e-'));
  const config = loadConfig(undefined, {
    SWIFTNEST_HOME: home,
    SWIFTNEST_LANG: 'en',
    SWIFTNEST_PLUGINS: PLUGIN_MANIFEST.plugins
      .filter(({ id }) => id !== 'tool-ultra')
      .map(({ id }) => `${id}=false`)
      .join(','),
  });
  const dir = toolUltraDir(config);
  if (process.env.SWIFTNEST_MEDIA_SOURCE) {
    await mkdir(join(home, 'dsh/profiles'), { recursive: true });
    await symlink(process.env.SWIFTNEST_MEDIA_SOURCE, dir, 'dir');
    if (!isBuilt(dir)) throw new Error('Wrong test package group pin');
  } else await installToolUltra(config, console.log);
  const outputDir = join(home, 'files/media');
  const inputDir = join(home, 'files');
  const tools = new Map<string, any>();
  const packs: any[] = [];
  await apply(mediaContext(tools, packs), {
    sourceModule: toolUltraModule(dir, '@lvy-jsd/dsh-tool-ultra-pack-media'),
    outputDir,
    inputDirs: [inputDir],
    lang: 'en',
    modelCacheDir: process.env.SWIFTNEST_MEDIA_MODEL_CACHE ?? join(home, 'models'),
    modelMirror: process.env.SWIFTNEST_MEDIA_MODEL_MIRROR,
  });
  const require = createRequire(join(dir, 'package.json'));
  const sharp = (await import(pathToFileURL(require.resolve('sharp')).href)).default;
  return {
    home,
    config,
    dir,
    inputDir,
    outputDir,
    tools,
    packs,
    sharp,
    close: () => rm(home, { recursive: true, force: true }),
  };
}
export type MediaHarness = Awaited<ReturnType<typeof mediaHarness>>;
export const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#287b65"/><text x="50" y="100" font-size="32">Hello</text></svg>';
export function htmlScene(title: string, background = '#287b65'): string {
  return `<style>
    @keyframes rise { from { transform: translateY(50px); opacity: 0.3; } to { transform: translateY(0); opacity: 1; } }
    main { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
      background: ${background}; color: white; font: bold 48px sans-serif; }
    h1 { animation: rise 0.5s both; }
    </style><main><h1>${title}</h1></main>`;
}
export async function voiceFixture(h: MediaHarness) {
  const voice = join(h.inputDir, 'voice.wav');
  await execute(process.env.SWIFTNEST_ESPEAK ?? 'espeak-ng', [
    '-v',
    'en-us',
    '-s',
    '135',
    '-w',
    voice,
    'Hello. This is a test of local speech recognition. The quick brown fox jumps over the lazy dog.',
  ]);
  const clip = join(h.inputDir, 'uploaded.mp4');
  await execute('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=320x180:r=24',
    '-i',
    voice,
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    clip,
  ]);
  return { voice, clip };
}

/** The same public multi-voice fixture used by sherpa-onnx and the pinned pack. */
export async function speakerFixture(h: MediaHarness): Promise<string> {
  const file = join(h.inputDir, 'meeting.wav');
  const cached = process.env.SWIFTNEST_MEDIA_SPEAKER_FIXTURE;
  const url =
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav';
  const bytes = cached ? await readFile(cached) : Buffer.from(await (await fetch(url)).arrayBuffer());
  const expected = 'bedf036caed208386c67b4ef4b11f83d74dd0d420b102163a1c33cd09cde7010';
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Wrong speech fixture checksum');
  await writeFile(file, bytes);
  return file;
}
