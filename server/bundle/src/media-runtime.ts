/** Host checks stay lazy, so missing optional programs never prevent server startup. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { message, type Language } from '@swiftnest/protocol';

const execute = promisify(execFile);

/** The release base comes from the pinned pack, so model URLs keep its layout. */
export async function modelMirror(
  lang: Language,
  releases: string,
  override?: string,
  fetchImpl = fetch,
): Promise<string> {
  if (override) return `${new URL(override).href.replace(/\/+$/u, '')}/`;
  const mirror = `https://gh-proxy.com/${releases}`;
  if (lang === 'zh-CN') return mirror;
  try {
    const response = await fetchImpl(`${releases}asr-models/silero_vad.onnx`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) return releases;
  } catch {
    // A short failed reachability check switches to the public release mirror.
  }
  return mirror;
}

export async function requireMediaPrograms(name: string, args: unknown, lang: Language): Promise<void> {
  const programs =
    name === 'video_understand'
      ? ['ffmpeg', 'ffprobe']
      : name === 'video_render' || name === 'audio_transcribe'
        ? ['ffmpeg']
        : [];
  for (const program of programs) {
    try {
      await execute(program, ['-version'], { timeout: 2000, maxBuffer: 65536 });
    } catch {
      throw new Error(message('media.ffmpeg_missing', lang));
    }
  }
  if (
    !['html_render', 'svg_render', 'chart_render', 'video_render'].includes(name) ||
    !/[\u3400-\u9fff]/u.test(JSON.stringify(args))
  )
    return;
  const fonts = await execute('fc-match', ['--format', '%{lang}', ':lang=zh-cn'], { timeout: 1000 }).catch(
    () => undefined,
  );
  if (fonts && !/(?:^|\|)zh(?:-|\||$)/i.test(fonts.stdout)) {
    throw new Error(message('media.cjk_font_missing', lang));
  }
}
