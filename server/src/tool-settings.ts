/** App overrides for Tool Ultra. YAML < App; preset credentials still resolve config env before process env. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpPresetView, ToolsView } from '@swiftnest/api';
import { text } from '@swiftnest/core';
import { checkCapabilityPacks, type ServerConfig } from './config.js';
import { ServerFailure } from './i18n.js';
import { JsonFileWriter, readJsonFile } from './json-store.js';
import type { KernelApply, KernelChange } from './kernel-apply.js';
import type { Language } from './preferences.js';
import { isBuilt, toolUltraDir, toolUltraModule } from './tool-ultra.js';

export interface ToolSettings {
  mcp?: { presets?: Record<string, { enabled: boolean }> };
  capabilities?: { packs?: Record<string, string | string[]>; deleted?: string[] };
}
export const toolSettingsFile = (home: string): string => join(home, 'tool-settings.json');

export function readToolSettings(home: string): ToolSettings {
  const saved = (readJsonFile(toolSettingsFile(home)) ?? {}) as ToolSettings;
  const presets = Object.fromEntries(
    Object.entries(saved.mcp?.presets ?? {})
      .filter(([, value]) => typeof value?.enabled === 'boolean')
      .map(([id, value]) => [id, { enabled: value.enabled }]),
  );
  checkCapabilityPacks(saved.capabilities?.packs);
  for (const name of saved.capabilities?.deleted ?? []) checkCapabilityPacks({ [name]: 'deleted' });
  return {
    mcp: { presets },
    capabilities: { packs: saved.capabilities?.packs ?? {}, deleted: saved.capabilities?.deleted ?? [] },
  };
}

export function withToolSettings(config: ServerConfig, saved: ToolSettings): ServerConfig {
  const presets = { ...config.mcp?.presets };
  for (const [id, value] of Object.entries(saved.mcp?.presets ?? {})) presets[id] = { ...presets[id], ...value };
  const packs = { ...config.capabilities?.packs, ...saved.capabilities?.packs };
  for (const name of saved.capabilities?.deleted ?? []) delete packs[name];
  return { ...config, mcp: { ...config.mcp, presets }, capabilities: { ...config.capabilities, packs } };
}

type Preset = Omit<McpPresetView, 'state' | 'enabled'>;
/** A missing or broken optional vendor must never stop the host. Never expose executable fields. */
export async function readMcpPresets(config: ServerConfig): Promise<Preset[]> {
  const dir = toolUltraDir(config);
  if (!isBuilt(dir)) return [];
  try {
    const { PRESETS } = await import(pathToFileURL(toolUltraModule(dir, '@lvy-jsd/dsh-tool-ultra-pack-mcp')).href);
    return PRESETS.map((preset: Preset) => ({
      id: preset.id,
      title: preset.title,
      summary: preset.summary,
      category: preset.category,
      source: preset.source,
      license: preset.license,
      needs: preset.needs.map(({ env, hint }) => ({ env, hint })),
    }));
  } catch {
    return [];
  }
}

export class ToolSettingsManager {
  private settings: ToolSettings;
  private booted: ToolSettings;
  private readonly writer: JsonFileWriter;
  private readonly change: KernelChange;
  private edits = Promise.resolve();

  constructor(
    private readonly base: ServerConfig,
    private readonly deps: { kernel: KernelApply; changed(): void },
  ) {
    this.settings = readToolSettings(base.home);
    this.booted = this.settings;
    this.writer = new JsonFileWriter(toolSettingsFile(base.home));
    this.change = {
      prepare: async () => {
        await this.edits;
      },
      rollback: () => this.save(this.booted),
      changed: () => deps.changed(),
      messages: { applied: 'toolsApplied', rolledBack: 'toolsRolledBack', busy: 'toolsApplyBusy' },
    };
  }
  config(config: ServerConfig = this.base): ServerConfig {
    return withToolSettings(config, this.settings);
  }
  /** Called only after the kernel is ready, so a failed boot cannot replace the rollback point. */
  loaded(): void {
    this.booted = this.settings;
    this.deps.changed();
  }
  async view(lang: Language): Promise<ToolsView> {
    const config = this.config();
    const catalog = await readMcpPresets(config);
    return {
      presets: catalog.map((preset) => {
        const options = config.mcp?.presets?.[preset.id];
        const enabled = options?.enabled === true;
        const needs = preset.needs.filter(({ env }) =>
          env === 'roots' ? !options?.roots?.length : !(options?.env?.[env] ?? process.env[env])?.trim(),
        );
        return { ...preset, needs, enabled, state: !enabled ? 'off' : needs.length ? 'needs-key' : 'on' };
      }),
      packs: Object.entries(config.capabilities?.packs ?? {}).map(([name, targets]) => ({
        name,
        targets: typeof targets === 'string' ? [targets] : targets,
      })),
      pending: this.snapshot(this.settings) !== this.snapshot(this.booted),
      apply: this.deps.kernel.view(this.change, lang),
    };
  }
  private snapshot(settings: ToolSettings): string {
    const config = withToolSettings(this.base, settings);
    return JSON.stringify([
      Object.entries(config.mcp?.presets ?? {})
        .filter(([, value]) => value.enabled === true)
        .map(([id]) => id)
        .sort(),
      Object.entries(config.capabilities?.packs ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, targets]) => [name, typeof targets === 'string' ? [targets] : targets]),
    ]);
  }
  private assertIdle(): void {
    if (this.deps.kernel.busy) throw new ServerFailure(text('toolsApplyBusy'));
  }
  async set(id: string, enabled: boolean): Promise<void> {
    this.assertIdle();
    if (!(await readMcpPresets(this.base)).some((preset) => preset.id === id))
      throw new ServerFailure(text('toolsPresetUnknown', id));
    await this.edit(() => ({
      ...this.settings,
      mcp: { presets: { ...this.settings.mcp?.presets, [id]: { enabled } } },
    }));
  }
  async setPack(name: string, targets: unknown): Promise<void> {
    this.assertIdle();
    checkCapabilityPacks({ [name]: targets } as Record<string, string | string[]>);
    await this.edit(() => ({
      ...this.settings,
      capabilities: {
        packs: { ...this.settings.capabilities?.packs, [name]: targets as string | string[] },
        deleted: this.settings.capabilities?.deleted?.filter((one) => one !== name),
      },
    }));
  }
  async deletePack(name: string): Promise<void> {
    this.assertIdle();
    checkCapabilityPacks({ [name]: 'deleted' });
    await this.edit(() => {
      const packs = { ...this.settings.capabilities?.packs };
      delete packs[name];
      return {
        ...this.settings,
        capabilities: { packs, deleted: [...new Set([...(this.settings.capabilities?.deleted ?? []), name])] },
      };
    });
  }
  private edit(update: () => ToolSettings): Promise<void> {
    this.assertIdle();
    const edit = this.edits.then(async () => {
      this.assertIdle();
      await this.save(update());
      this.deps.changed();
    });
    this.edits = edit.catch(() => {});
    return edit;
  }
  private save(settings: ToolSettings): Promise<void> {
    return this.writer.write(settings, () => {
      this.settings = settings;
    });
  }
  apply(): void {
    this.deps.kernel.start(this.change);
  }
  async flush(): Promise<void> {
    await this.edits;
    await this.writer.flush();
  }
}
