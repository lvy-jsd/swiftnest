import { relayConfig, type RelayConfig } from '@swiftnest/channel';
import { text } from '@swiftnest/core';
import { ServerFailure } from './i18n.js';
import { checkOverrides, fileOverrides, parsePluginsEnv } from './plugins.js';
/**
 * Swiftnest Server configuration: one YAML file, every field optional, with
 * environment overrides for containers. Defaults are for a stranger's machine,
 * never for a particular deployment.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ExpertApproval, ModelRoute } from '@swiftnest/api';

export interface ModelConfig {
  /** OpenAI-compatible base URL, including `/v1`. */
  baseUrl: string;
  /** Model id as the endpoint knows it. */
  id: string;
  /** Display name. */
  name: string;
  /** Tokens the model reads at once. Detected from the local server unless set. */
  contextWindow: number;
  /** The model reads images itself. Detected from the local server unless set. */
  vision: boolean;
  /** What the owner did not set, so the server asks the local model server at boot. */
  detect?: { contextWindow?: true; vision?: true };
  maxTokens: number;
  /** Environment variable holding the API key; local servers accept any value. */
  apiKeyEnv: string;
}

export interface CloudConfig {
  /** The model every chat uses. */
  main?: ModelRoute;
  /** The stronger model the assistant hands hard tasks to. */
  expert?: ModelRoute;
  expertApproval: ExpertApproval;
  /** The owner's vision models that describe photos when the main model cannot see, best first. */
  vision?: ModelRoute[];
}

/** An anonymous OpenAI-compatible vision service; photos go there only with the owner's consent. */
export interface FreeVisionService {
  baseUrl: string;
  /** Tried in order. */
  models: string[];
}

/** OVHcloud AI Endpoints answer without an account or key, with a rate limit. */
export const FREE_VISION: FreeVisionService = {
  baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  models: ['Qwen3.5-397B-A17B', 'Qwen2.5-VL-72B-Instruct'],
};

export interface ServerConfig {
  relay?: RelayConfig;
  lang?: 'zh-CN' | 'en';
  /** Everything Swiftnest owns lives here; DSH's home is `<home>/dsh`. */
  home: string;
  /** One concrete local IP address (DSH refuses wildcards). */
  host: string;
  port: number;
  /** Built web App directory; otherwise resolved from the optional App package. */
  appDist?: string;
  /** Default persona for DSH's system prompt and agent presets; supports {{model}}. */
  persona: string;
  /** Name the Apps show on the assistant's messages (e.g. "小艾"); Apps fall back to a generic label. */
  assistantName?: string;
  /** Per-plugin on/off overrides of the plugin manifest's defaults, by id. */
  plugins: Record<string, boolean>;
  /** The subset set by SWIFTNEST_PLUGINS: the administrator's choice, which the App cannot change. */
  pluginLocks: Record<string, boolean>;
  model: ModelConfig;
  /** Cloud models chosen in the App (see model-settings.ts); unset routes use `model`. */
  cloud?: CloudConfig;
  /** Where photos go when nothing else can read them and the owner agreed; defaults to {@link FREE_VISION}. */
  freeVision?: FreeVisionService;
  files?: { quotaBytes: number };
  /** Optional media resources; upload consent is supplied by ModelManager from saved Models settings. */
  media?: { modelMirror?: string; soundfont?: string; soundfontUrl?: string; geminiUploads?: boolean };
  /** Built-in central memory: on without installing or configuring a plugin. */
  memory?: { enabled: boolean; auto?: boolean };
  devices: { host: string; port: number; mdns: boolean };
}

function checkedRelayConfig(value: unknown): RelayConfig | undefined {
  try {
    return relayConfig(value);
  } catch {
    throw new ServerFailure(text('relayInvalidSettings'));
  }
}

export const DEFAULT_PORT = 3077;
export const DEFAULT_PERSONA = '你是 Swiftnest 中的助手，由 {{model}} 模型驱动。默认使用简体中文，按用户选择切换语言。';

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'swiftnest');
}

/** Ollama's OpenAI-compatible endpoint is the default local model server. */
export const DEFAULT_MODEL: ModelConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  id: 'qwen3',
  name: '本地模型',
  contextWindow: 32768,
  vision: false,
  maxTokens: 8192,
  apiKeyEnv: 'SWIFTNEST_MODEL_API_KEY',
};

/** Model facts the owner set; the rest keep their defaults and are detected at boot. */
function ownerFacts(
  contextWindow: number | undefined,
  vision: boolean | undefined,
): Pick<ModelConfig, 'contextWindow' | 'vision' | 'detect'> {
  const detect = {
    ...(contextWindow === undefined ? { contextWindow: true as const } : {}),
    ...(vision === undefined ? { vision: true as const } : {}),
  };
  return {
    contextWindow: contextWindow ?? DEFAULT_MODEL.contextWindow,
    vision: vision ?? DEFAULT_MODEL.vision,
    ...(Object.keys(detect).length ? { detect } : {}),
  };
}
function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (v !== 'true' && v !== 'false') throw new ServerFailure(text('modelVisionMustBoolean'));
  return v === 'true';
}

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export function loadConfig(file?: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let fromFile: Partial2<ServerConfig> = {};
  if (file) {
    if (!existsSync(file)) throw new ServerFailure(text('configFileNotFound', file));
    fromFile = (parse(readFileSync(file, 'utf8')) ?? {}) as Partial2<ServerConfig>;
  }
  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  const appDist = env.SWIFTNEST_APP_DIST || fromFile.appDist;
  if (env.SWIFTNEST_MEMORY !== undefined && !['true', 'false'].includes(env.SWIFTNEST_MEMORY))
    throw new ServerFailure(text('memoryEnabledMustBoolean'));
  if (
    fromFile.memory !== undefined &&
    (!fromFile.memory ||
      typeof fromFile.memory !== 'object' ||
      Array.isArray(fromFile.memory) ||
      (fromFile.memory.enabled === undefined
        ? fromFile.memory.auto === undefined
        : typeof fromFile.memory.enabled !== 'boolean'))
  )
    throw new ServerFailure(text('memoryEnabledMustBoolean'));
  validateMemoryAuto(fromFile.memory?.auto, env.SWIFTNEST_MEMORY_AUTO);
  const pluginLocks = parsePluginsEnv(env.SWIFTNEST_PLUGINS);
  const config: ServerConfig = {
    relay: checkedRelayConfig(
      env.SWIFTNEST_RELAY_ADDRESS
        ? {
            address: env.SWIFTNEST_RELAY_ADDRESS,
            secret: env.SWIFTNEST_RELAY_SECRET,
          }
        : fromFile.relay,
    ),
    lang: (env.SWIFTNEST_LANG ?? fromFile.lang) === 'en' ? 'en' : 'zh-CN',
    home: resolve(env.SWIFTNEST_HOME ?? fromFile.home ?? defaultHome(env)),
    host: env.SWIFTNEST_HOST ?? fromFile.host ?? '127.0.0.1',
    port: num(env.SWIFTNEST_PORT) ?? fromFile.port ?? DEFAULT_PORT,
    appDist: appDist ? resolve(appDist) : undefined,
    persona:
      env.SWIFTNEST_PERSONA ??
      fromFile.persona ??
      ((env.SWIFTNEST_LANG ?? fromFile.lang) === 'en'
        ? 'You are a helpful assistant in Swiftnest, powered by the {{model}} model.'
        : DEFAULT_PERSONA),
    assistantName: env.SWIFTNEST_ASSISTANT_NAME || fromFile.assistantName,
    memory: {
      enabled:
        env.SWIFTNEST_MEMORY === undefined ? (fromFile.memory?.enabled ?? true) : env.SWIFTNEST_MEMORY === 'true',
      auto:
        env.SWIFTNEST_MEMORY_AUTO === undefined
          ? (fromFile.memory?.auto ?? true)
          : env.SWIFTNEST_MEMORY_AUTO === 'true',
    },
    plugins: { ...fileOverrides(fromFile.plugins), ...pluginLocks },
    pluginLocks,
    media: fromFile.media,
    devices: {
      host: env.SWIFTNEST_DEVICES_HOST ?? fromFile.devices?.host ?? env.SWIFTNEST_HOST ?? fromFile.host ?? '127.0.0.1',
      port: num(env.SWIFTNEST_DEVICES_PORT) ?? fromFile.devices?.port ?? 7711,
      mdns:
        env.SWIFTNEST_DEVICES_MDNS === undefined
          ? (fromFile.devices?.mdns ?? true)
          : env.SWIFTNEST_DEVICES_MDNS !== 'false',
    },
    freeVision: {
      baseUrl: env.SWIFTNEST_FREE_VISION_BASE_URL || fromFile.freeVision?.baseUrl || FREE_VISION.baseUrl,
      models: fromFile.freeVision?.models ?? FREE_VISION.models,
    },
    files: { quotaBytes: num(env.SWIFTNEST_FILES_QUOTA_BYTES) ?? fromFile.files?.quotaBytes ?? 100 * 1024 ** 3 },
    model: {
      ...DEFAULT_MODEL,
      name: (env.SWIFTNEST_LANG ?? fromFile.lang) === 'en' ? 'Local model' : DEFAULT_MODEL.name,
      ...fromFile.model,
      ...(env.SWIFTNEST_MODEL_BASE_URL ? { baseUrl: env.SWIFTNEST_MODEL_BASE_URL } : {}),
      ...(env.SWIFTNEST_MODEL_ID ? { id: env.SWIFTNEST_MODEL_ID } : {}),
      ...ownerFacts(
        num(env.SWIFTNEST_MODEL_CONTEXT_WINDOW) ?? fromFile.model?.contextWindow,
        bool(env.SWIFTNEST_MODEL_VISION) ?? fromFile.model?.vision,
      ),
    },
  };
  validate(config);
  return config;
}

export function validate(config: ServerConfig): void {
  checkedRelayConfig(config.relay);
  validateMemoryAuto(config.memory?.auto);
  if (config.memory !== undefined && (!config.memory || typeof config.memory.enabled !== 'boolean'))
    throw new ServerFailure(text('memoryEnabledMustBoolean'));
  if (config.assistantName !== undefined && typeof config.assistantName !== 'string')
    throw new ServerFailure(text('assistantNameMustString'));
  validateMediaUrl(config.media?.modelMirror, 'media.model_mirror_invalid');
  validateMediaUrl(config.media?.soundfontUrl, 'media.soundfont_url_invalid');
  if (config.media?.soundfont !== undefined && typeof config.media.soundfont !== 'string')
    throw new ServerFailure(text('media.soundfont_path_invalid'));
  checkOverrides(config.plugins);
  if (config.files && (!Number.isSafeInteger(config.files.quotaBytes) || config.files.quotaBytes < 0))
    throw new ServerFailure(text('filesQuotabytesMustNonnegativeSafeInteger'));
  if (!Number.isInteger(config.devices.port) || config.devices.port < 0 || config.devices.port > 65535)
    throw new ServerFailure(text('devicesPortMustInteger065535'));
  if (typeof config.devices.host !== 'string' || !config.devices.host)
    throw new ServerFailure(text('devicesHostMustAddress'));
  if (typeof config.devices.mdns !== 'boolean') throw new ServerFailure(text('devicesMdnsMustBoolean'));
  if (typeof config.persona !== 'string') throw new ServerFailure(text('personaMustString'));
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ServerFailure(text('portMustInteger065535Got', config.port));
  }
  if (config.host === '0.0.0.0' || config.host === '::') {
    throw new ServerFailure(text('hostMustOneConcreteAddressExample'));
  }
  try {
    new URL(config.model.baseUrl);
  } catch {
    throw new ServerFailure(text('modelBaseurlNotUrl', config.model.baseUrl));
  }
  if (config.freeVision) validateFreeVision(config.freeVision);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.model.apiKeyEnv)) {
    throw new ServerFailure(text('modelApikeyenvMustEnvironmentVariableName', config.model.apiKeyEnv));
  }
  if (typeof config.model.vision !== 'boolean') throw new ServerFailure(text('modelVisionMustBoolean'));
  if (!Number.isInteger(config.model.contextWindow) || config.model.contextWindow < 1024) {
    throw new ServerFailure(text('modelContextWindowInvalid', String(config.model.contextWindow)));
  }
}

function validateFreeVision(service: FreeVisionService): void {
  try {
    new URL(service.baseUrl);
  } catch {
    throw new ServerFailure(text('freeVisionInvalid'));
  }
  if (!Array.isArray(service.models) || !service.models.length || service.models.some((m) => typeof m !== 'string'))
    throw new ServerFailure(text('freeVisionInvalid'));
}

function validateMemoryAuto(value: unknown, environment?: string): void {
  if (
    (value !== undefined && typeof value !== 'boolean') ||
    (environment !== undefined && !['true', 'false'].includes(environment))
  )
    throw new ServerFailure(text('memoryAutoMustBoolean'));
}

function validateMediaUrl(
  value: string | undefined,
  key: 'media.model_mirror_invalid' | 'media.soundfont_url_invalid',
) {
  if (value === undefined) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new ServerFailure(text(key));
  }
}
