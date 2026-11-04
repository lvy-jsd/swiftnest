/** Swiftnest's integration boundary; the pinned media source and its defaults stay untouched. */
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Language } from '@swiftnest/protocol';
import { mediaFiles, type MediaFile } from './media-files.js';
import { modelMirror, requireMediaPrograms } from './media-runtime.js';

export const name = 'swiftnest-media';
export const inject = ['tools'];
export interface MediaConfig {
  sourceModule: string;
  outputDir: string;
  inputDirs: string[];
  modelCacheDir: string;
  modelMirror?: string;
  lang: Language;
}
interface Result {
  text: string;
  mediaFiles: MediaFile[];
}
interface Definition {
  name: string;
  output: unknown;
  execute(args: unknown, exec: unknown): Promise<string>;
}
interface Context {
  tools: { register(tool: unknown): unknown };
}

export function adaptTool(tool: Definition, config: MediaConfig): unknown {
  return {
    ...tool,
    output: {
      schema: {
        type: 'object',
        required: ['text', 'mediaFiles'],
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          mediaFiles: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'name'],
              additionalProperties: false,
              properties: { path: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      },
      render: (_args: unknown, value: Result) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args: unknown, value: Result) => ({ mediaFiles: value.mediaFiles }),
    },
    async execute(args: unknown, exec: unknown): Promise<Result> {
      await requireMediaPrograms(tool.name, args, config.lang);
      const text = await tool.execute(args, exec);
      return { text, mediaFiles: await mediaFiles(text, config.outputDir) };
    },
  };
}

export async function apply(ctx: Context, config: MediaConfig): Promise<void> {
  await Promise.all([config.outputDir, ...config.inputDirs].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
  const upstream = await import(pathToFileURL(config.sourceModule).href);
  const tools = { register: (tool: Definition) => ctx.tools.register(adaptTool(tool, config)) };
  const proxy = new Proxy(ctx, {
    get(target, key) {
      if (key === 'tools') return tools;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const releases = upstream.resolveSettings({}).speech.mirror;
  const mirror = await modelMirror(config.lang, releases, config.modelMirror);
  upstream.apply(proxy, { ...config, modelMirror: mirror });
}
