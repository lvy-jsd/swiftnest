import { text } from '@swiftnest/core';
import { ServerFailure } from './i18n.js';
/**
 * Swiftnest Server configuration: one YAML file, every field optional, with
 * environment overrides for containers. Defaults are for a stranger's machine,
 * never for a particular deployment.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface ModelConfig {
  /** OpenAI-compatible base URL, including `/v1`. */
  baseUrl: string;
  /** Model id as the endpoint knows it. */
  id: string;
  /** Display name. */
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Environment variable holding the API key; local servers accept any value. */
  apiKeyEnv: string;
}

export interface ServerConfig {
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
  /** Enable the pinned, separately installed Tool Ultra bundle. */
  toolUltra: boolean;
  model: ModelConfig;
  files?: { quotaBytes: number };
  devices: { host: string; port: number; mdns: boolean };
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
  maxTokens: 8192,
  apiKeyEnv: 'SWIFTNEST_MODEL_API_KEY',
};

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export function loadConfig(file?: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let fromFile: Partial2<ServerConfig> = {};
  if (file) {
    if (!existsSync(file)) throw new ServerFailure(text('configFileNotFound', file));
    fromFile = (parse(readFileSync(file, 'utf8')) ?? {}) as Partial2<ServerConfig>;
  }
  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  const appDist = env.SWIFTNEST_APP_DIST || fromFile.appDist;
  const config: ServerConfig = {
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
    assistantName: env.SWIFTNEST_ASSISTANT_NAME || fromFile.assistantName || undefined,
    toolUltra:
      env.SWIFTNEST_TOOL_ULTRA === undefined ? (fromFile.toolUltra ?? true) : env.SWIFTNEST_TOOL_ULTRA !== 'false',
    devices: {
      host: env.SWIFTNEST_DEVICES_HOST ?? fromFile.devices?.host ?? env.SWIFTNEST_HOST ?? fromFile.host ?? '127.0.0.1',
      port: num(env.SWIFTNEST_DEVICES_PORT) ?? fromFile.devices?.port ?? 7711,
      mdns:
        env.SWIFTNEST_DEVICES_MDNS === undefined
          ? (fromFile.devices?.mdns ?? true)
          : env.SWIFTNEST_DEVICES_MDNS !== 'false',
    },
    files: { quotaBytes: num(env.SWIFTNEST_FILES_QUOTA_BYTES) ?? fromFile.files?.quotaBytes ?? 100 * 1024 ** 3 },
    model: {
      ...DEFAULT_MODEL,
      name: (env.SWIFTNEST_LANG ?? fromFile.lang) === 'en' ? 'Local model' : DEFAULT_MODEL.name,
      ...fromFile.model,
      ...(env.SWIFTNEST_MODEL_BASE_URL ? { baseUrl: env.SWIFTNEST_MODEL_BASE_URL } : {}),
      ...(env.SWIFTNEST_MODEL_ID ? { id: env.SWIFTNEST_MODEL_ID } : {}),
    },
  };
  validate(config);
  return config;
}

export function validate(config: ServerConfig): void {
  if (config.assistantName !== undefined && typeof config.assistantName !== 'string')
    throw new ServerFailure(text('assistantNameMustString'));
  if (typeof config.toolUltra !== 'boolean') throw new ServerFailure(text('toolUltraMustBoolean'));
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
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.model.apiKeyEnv)) {
    throw new ServerFailure(text('modelApikeyenvMustEnvironmentVariableName', config.model.apiKeyEnv));
  }
}
