/** Explicit opt-in: synthetic recording sent to Google using the single Models key store. */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { apply, type MediaConfig } from '../bundle/src/media.js';
import { KernelApply } from '../src/kernel-apply.js';
import { ModelManager } from '../src/model-manager.js';
import { ModelSettingsStore } from '../src/model-settings.js';
import { toolUltraPatch } from '../src/tool-ultra.js';
import { mediaContext, mediaHarness, voiceFixture } from './fixtures/media-harness.js';

async function geminiTestKey(): Promise<string | undefined> {
  const file = join(homedir(), '.config/swiftnest/gemini.key');
  return readFile(file, 'utf8').then(
    (value) => value.trim(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
}

it.skipIf(process.env.SWIFTNEST_GEMINI_E2E !== '1')(
  'Google model key + opt-in sends audio to Gemini with a privacy notice; off stays local',
  async ({ skip }) => {
    const key = await geminiTestKey();
    if (key === undefined) return skip('Gemini test key file is missing; no Google request was made.');
    if (!key) throw new Error('The Gemini test key file is empty.');
    const h = await mediaHarness();
    try {
      const models = new ModelManager(ModelSettingsStore.open(h.home), {
        kernel: new KernelApply({ restart: async () => {}, fail: () => {}, log: () => {}, lang: 'en' }),
        changed: () => {},
      });
      await models.setKey('google', key);
      vi.stubEnv('SWIFTNEST_MODEL_KEY_GOOGLE', models.env().SWIFTNEST_MODEL_KEY_GOOGLE!);
      const { voice } = await voiceFixture(h);
      const load = async (enabled: boolean) => {
        await models.update({ geminiUploads: enabled });
        const rows = toolUltraPatch(h.dir, models.config(h.config)) as { insert: { config: MediaConfig }[] }[];
        const config = rows.at(-1)!.insert[0]!.config;
        expect(config).not.toHaveProperty('geminiApiKey');
        config.modelCacheDir = process.env.SWIFTNEST_MEDIA_MODEL_CACHE ?? config.modelCacheDir;
        const tools = new Map<string, any>();
        await apply(mediaContext(tools, []), config);
        return tools.get('audio_transcribe');
      };
      const cloud = await (await load(true)).execute({ file: voice, engine: 'auto', language: 'en' }, {});
      expect(cloud.text.startsWith('analysed by Gemini ')).toBe(true);
      expect(cloud.text).toContain('(file uploaded to Google)');
      expect(cloud.text.includes(key)).toBe(false);
      const localTool = await load(false);
      for (const engine of ['auto', 'gemini']) {
        const local = await localTool.execute({ file: voice, engine, speakers: false, language: 'en' }, {});
        expect(local.text).toContain('local model SenseVoice Small');
        expect(local.text).not.toContain('(file uploaded to Google)');
        if (engine === 'gemini') expect(local.text).toContain('Gemini uploads are off');
      }
      expect((await readFile(join(h.home, 'models.json'), 'utf8')).includes(key)).toBe(false);
      await expect(stat(join(h.home, 'media-gemini.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.unstubAllEnvs();
      await h.close();
    }
  },
  600_000,
);
