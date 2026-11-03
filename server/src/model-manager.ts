/**
 * What the App's model page drives: which model chats use, which stronger model hard
 * tasks go to, and the providers' API keys. Changes are saved first and take effect when
 * the owner applies them, which restarts the DSH kernel through the shared `KernelApply`.
 */
import type { ModelProviderView, ModelRoute, ModelsView } from '@swiftnest/api';
import type { ServerConfig } from './config.js';
import { message } from './i18n.js';
import type { KernelApply, KernelChange } from './kernel-apply.js';
import {
  LOCAL_PROVIDER,
  MODEL_PROVIDERS,
  type ModelSettings,
  type ModelSettingsStore,
  updateModelSettings,
} from './model-settings.js';
import type { Language } from './preferences.js';

export interface ModelManagerDeps {
  kernel: KernelApply;
  /** The view changed (settings, keys, apply progress). */
  changed(): void;
}

export class ModelManager {
  /** Settings the running kernel booted with: the rollback point. */
  private booted: ModelSettings;
  /** Settings and keys the running kernel booted with: the `pending` baseline. */
  private bootedSnapshot: string;
  /** The local model as the running kernel uses it, once it has booted. */
  private local?: Pick<ServerConfig['model'], 'contextWindow' | 'vision'>;
  private readonly change: KernelChange;

  constructor(
    private readonly store: ModelSettingsStore,
    private readonly deps: ModelManagerDeps,
  ) {
    this.booted = store.settings;
    this.bootedSnapshot = this.snapshot();
    this.change = {
      // The free-vision answer took effect when given; a failed apply keeps it.
      rollback: () => this.store.save({ ...this.booted, freeVision: this.store.settings.freeVision }),
      changed: () => this.deps.changed(),
      messages: { applied: 'modelsApplied', rolledBack: 'modelsRolledBack', busy: 'modelsApplyBusy' },
    };
  }

  /** `config` with the owner's cloud models; a route whose provider has no key is left out. */
  config(config: ServerConfig): ServerConfig {
    const { main, expert, expertApproval } = this.store.settings;
    return {
      ...config,
      cloud: {
        ...(main && this.usable(main.provider) ? { main } : {}),
        ...(expert && this.usable(expert.provider) ? { expert } : {}),
        expertApproval,
        vision: this.visionRoutes(),
      },
    };
  }

  /** Kernel environment carrying the saved keys. */
  env(): Record<string, string> {
    return this.store.keyEnv();
  }

  /** The kernel started with the current settings and this local model. */
  loaded(local?: Pick<ServerConfig['model'], 'contextWindow' | 'vision'>): void {
    this.local = local && { contextWindow: local.contextWindow, vision: local.vision };
    this.booted = this.store.settings;
    this.bootedSnapshot = this.snapshot();
  }

  view(config: ServerConfig, lang: Language): ModelsView {
    const { main, expert, expertApproval, freeVision } = this.store.settings;
    const localVision = this.local?.vision ?? config.model.vision;
    return {
      local: {
        name: config.model.name,
        model: config.model.id,
        contextWindow: this.local?.contextWindow ?? config.model.contextWindow,
        vision: localVision,
      },
      providers: MODEL_PROVIDERS.map((provider) => this.providerView(provider.id, lang)),
      ...(main ? { main } : {}),
      ...(expert ? { expert } : {}),
      expertApproval,
      vision: {
        needed: !localVision && (!main || main.provider === LOCAL_PROVIDER),
        readers: this.visionRoutes().map((route) => route.provider),
        free: freeVision,
      },
      pending: this.snapshot() !== this.bootedSnapshot,
      apply: this.deps.kernel.view(this.change, lang),
    };
  }

  async update(update: unknown): Promise<void> {
    await this.store.save(updateModelSettings(this.store.settings, update));
    this.deps.changed();
  }

  /** Save a key. A key in use changes the running kernel only at the next apply. */
  async setKey(provider: string, key: unknown): Promise<void> {
    await this.store.setKey(provider, key);
    this.deps.changed();
  }

  get busy(): boolean {
    return this.deps.kernel.busy;
  }

  apply(): void {
    this.deps.kernel.start(this.change);
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  /** What the running kernel would differ in; the free-vision answer is read live, so it never is. */
  private snapshot(): string {
    const { freeVision: _live, ...settings } = this.store.settings;
    return JSON.stringify([settings, this.store.keyEnv()]);
  }

  /** A vision model of every provider the owner has a key for. */
  private visionRoutes(): ModelRoute[] {
    return MODEL_PROVIDERS.filter((provider) => provider.visionModel && this.store.key(provider.id)).map(
      (provider) => ({ provider: provider.id, model: provider.visionModel! }),
    );
  }

  private usable(provider: string): boolean {
    return provider === LOCAL_PROVIDER || this.store.key(provider) !== undefined;
  }

  private providerView(id: string, lang: Language): ModelProviderView {
    const provider = MODEL_PROVIDERS.find((candidate) => candidate.id === id)!;
    const keyHint = this.store.keyHint(id);
    return {
      id,
      name: message(providerNameKey(id), lang),
      keyUrl: provider.keyUrl,
      recommendedModel: provider.recommendedModel,
      ...(keyHint ? { keyHint } : {}),
    };
  }
}

/** `moonshotai-cn` -> `modelProviderMoonshotaiCn`, its catalog entry. */
function providerNameKey(id: string): Parameters<typeof message>[0] {
  return `modelProvider${id.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase())}` as Parameters<
    typeof message
  >[0];
}
