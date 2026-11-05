/**
 * Cloud models the owner adds in the App, saved in `<home>/models.json`, and their API
 * keys in `<home>/model-keys.json` (owner-only, never sent back). The local model stays
 * the default; the owner may make a cloud model the main model or the expert that
 * hard tasks are handed to. Providers come from the DSH model catalog, so a provider
 * here needs only an id and a key.
 */
import { join } from 'node:path';
import type { ExpertApproval, FreeVisionChoice, ModelRoute, ModelSettingsUpdate } from '@swiftnest/api';
import { text } from '@swiftnest/core';
import { ServerFailure } from './i18n.js';
import { JsonFileWriter, readJsonFile } from './json-store.js';

export interface ModelProvider {
  id: string;
  /** Where a beginner creates an API key. */
  keyUrl: string;
  /** A current strong model of this provider; the owner may type another id. */
  recommendedModel: string;
  /** A fast model of this provider that reads images, used to describe photos to a model that cannot. */
  visionModel?: string;
}

/** The providers the App offers, in display order. Ids are DSH catalog provider ids. */
export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    id: 'deepseek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    recommendedModel: 'deepseek-v4-pro',
    visionModel: 'deepseek-flash',
  },
  {
    id: 'moonshotai-cn',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    recommendedModel: 'kimi-k3',
    visionModel: 'kimi-k2.6',
  },
  {
    id: 'google',
    keyUrl: 'https://aistudio.google.com/apikey',
    recommendedModel: 'gemini-pro-latest',
    visionModel: 'gemini-flash-latest',
  },
  {
    id: 'anthropic',
    keyUrl: 'https://platform.claude.com/settings/keys',
    recommendedModel: 'claude-opus-5-5',
    visionModel: 'claude-haiku-5-5',
  },
  {
    id: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
    recommendedModel: 'gpt-6.1-sol',
    visionModel: 'gpt-6-luna',
  },
  {
    id: 'openrouter',
    keyUrl: 'https://openrouter.ai/keys',
    recommendedModel: 'anthropic/claude-opus-5.5',
    visionModel: '~google/gemini-flash-latest',
  },
];

export const LOCAL_PROVIDER = 'local';

export interface ModelSettings {
  main?: ModelRoute;
  expert?: ModelRoute;
  expertApproval: ExpertApproval;
  geminiUploads: boolean;
  /**
   * May photos go to the free anonymous vision service when nothing else can read
   * them? `ask` until the owner answers. The kernel reads this field from the file at
   * each photo, so the answer takes effect without a restart.
   */
  freeVision: FreeVisionChoice;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = { expertApproval: 'ask', freeVision: 'ask', geminiUploads: false };

const FREE_VISION_CHOICES: readonly FreeVisionChoice[] = ['ask', 'on', 'off'];

function isFreeVisionChoice(value: unknown): value is FreeVisionChoice {
  return FREE_VISION_CHOICES.includes(value as FreeVisionChoice);
}

/** The environment variable that carries a provider's key into the DSH kernel. */
export function modelKeyEnv(provider: string): string {
  return `SWIFTNEST_MODEL_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function providerById(id: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.id === id);
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const KEY = /^[\x21-\x7e]{8,512}$/;

function validRoute(value: unknown): ModelRoute | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { provider, model } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || typeof model !== 'string' || !MODEL_ID.test(model)) return undefined;
  return provider === LOCAL_PROVIDER || providerById(provider) ? { provider, model } : undefined;
}

/** Saved settings, dropping anything invalid or naming a provider the App no longer offers. */
export function parseModelSettings(value: unknown): ModelSettings {
  const saved = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const main = validRoute(saved.main);
  const expert = validRoute(saved.expert);
  return {
    ...(main ? { main } : {}),
    ...(expert ? { expert } : {}),
    expertApproval: saved.expertApproval === 'auto' ? 'auto' : 'ask',
    geminiUploads: saved.geminiUploads === true,
    freeVision: isFreeVisionChoice(saved.freeVision) ? saved.freeVision : 'ask',
  };
}

/** Apply an update from the App; an invalid field rejects the whole update. */
export function updateModelSettings(current: ModelSettings, update: unknown): ModelSettings {
  if (!update || typeof update !== 'object' || Array.isArray(update))
    throw new ServerFailure(text('modelsInvalidUpdate'));
  const fields = update as ModelSettingsUpdate & Record<string, unknown>;
  const next: ModelSettings = { ...current };
  for (const key of Object.keys(fields)) {
    if (key === 'expertApproval') {
      if (fields.expertApproval !== 'ask' && fields.expertApproval !== 'auto')
        throw new ServerFailure(text('modelsInvalidUpdate'));
      next.expertApproval = fields.expertApproval;
    } else if (key === 'geminiUploads') {
      if (typeof fields.geminiUploads !== 'boolean') throw new ServerFailure(text('modelsInvalidUpdate'));
      next.geminiUploads = fields.geminiUploads;
    } else if (key === 'freeVision') {
      if (!isFreeVisionChoice(fields.freeVision)) throw new ServerFailure(text('modelsInvalidUpdate'));
      next.freeVision = fields.freeVision;
    } else if (key === 'main' || key === 'expert') {
      setRoute(next, key, fields[key]);
    } else throw new ServerFailure(text('modelsInvalidUpdate'));
  }
  return next;
}

function setRoute(settings: ModelSettings, key: 'main' | 'expert', value: unknown): void {
  if (value === null) {
    delete settings[key];
    return;
  }
  const route = validRoute(value);
  if (!route) throw new ServerFailure(text('modelsInvalidUpdate'));
  settings[key] = route;
}

/** The owner's model choices and keys on disk; writes are serialized and atomic. */
export class ModelSettingsStore {
  private readonly settingsWriter: JsonFileWriter;
  private readonly keysWriter: JsonFileWriter;
  private keyMap: Record<string, string>;

  private constructor(
    home: string,
    public settings: ModelSettings,
  ) {
    this.settingsWriter = new JsonFileWriter(join(home, 'models.json'));
    this.keysWriter = new JsonFileWriter(join(home, 'model-keys.json'));
    this.keyMap = readKeys(join(home, 'model-keys.json'));
  }

  static open(home: string): ModelSettingsStore {
    return new ModelSettingsStore(home, parseModelSettings(readJsonFile(join(home, 'models.json'))));
  }

  save(settings: ModelSettings): Promise<void> {
    return this.settingsWriter.write(settings, () => {
      this.settings = settings;
    });
  }

  /** Save or, with an empty key, remove a provider's API key. */
  setKey(provider: string, key: unknown): Promise<void> {
    if (!providerById(provider)) throw new ServerFailure(text('modelsUnknownProvider', provider));
    if (typeof key !== 'string' || (key.trim() !== '' && !KEY.test(key.trim())))
      throw new ServerFailure(text('modelsInvalidKey'));
    const keys = { ...this.keyMap };
    if (key.trim()) keys[provider] = key.trim();
    else delete keys[provider];
    return this.keysWriter.write(keys, () => {
      this.keyMap = keys;
    });
  }

  key(provider: string): string | undefined {
    return this.keyMap[provider];
  }

  keyHint(provider: string): string | undefined {
    return this.keyMap[provider]?.slice(-4);
  }

  /** Kernel environment: one variable per saved key. */
  keyEnv(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.keyMap).map(([id, key]) => [modelKeyEnv(id), key]));
  }

  flush(): Promise<void> {
    return Promise.all([this.settingsWriter.flush(), this.keysWriter.flush()]).then(() => {});
  }
}

function readKeys(file: string): Record<string, string> {
  const saved = readJsonFile(file);
  if (!saved || typeof saved !== 'object') return {};
  return Object.fromEntries(
    Object.entries(saved).filter(([id, key]) => providerById(id) && typeof key === 'string' && KEY.test(key)),
  );
}
