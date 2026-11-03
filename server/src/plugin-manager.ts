/**
 * What the App's plugin page drives: the audited plugins and their switches, community
 * market installs (labelled unaudited), and applying changes, which installs what is
 * missing and restarts the DSH kernel through the shared `KernelApply`. If the kernel
 * cannot start with the new plugins, the switches go back to the last ones that booted.
 */
import type { PluginsView, PluginView } from '@swiftnest/api';
import { isText, text } from '@swiftnest/core';
import type { Log } from './command.js';
import type { ServerConfig } from './config.js';
import { message, ServerFailure } from './i18n.js';
import { JsonFileWriter } from './json-store.js';
import type { KernelApply, KernelChange } from './kernel-apply.js';
import type { Language } from './preferences.js';
import { type PluginSwitches, pluginSettingsFile, readPluginSettings, withPluginSettings } from './plugin-settings.js';
import { isEnabled, PLUGIN_MANIFEST, type Plugin } from './plugins.js';
import { marketInstalls, type ProfilePlugins } from './profile-plugins.js';
import { profileDir } from './profile.js';

export interface PluginManagerDeps {
  install(config: ServerConfig, log: Log): Promise<void>;
  /** Restarts the kernel; it reads `config()` and reports back through `loaded()`. */
  kernel: KernelApply;
  /** The view changed (switch, apply progress). */
  changed(): void;
  log: Log;
}

/** `vision-router` -> `pluginVisionRouter`, the prefix of its catalog entries. */
function catalogPrefix(id: string): string {
  return `plugin${id.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase())}`;
}

/** The catalog entry `<prefix><part>`; every manifest plugin has Title and Summary (see the test). */
export function pluginText(id: string, part: 'Title' | 'Summary' | 'Note', lang: Language): string | undefined {
  const entry = { key: `${catalogPrefix(id)}${part}` };
  return isText(entry) ? message(entry.key, lang) : undefined;
}

export class PluginManager {
  private switches: PluginSwitches;
  /** Switches the running kernel booted with: the rollback point. */
  private booted: PluginSwitches;
  private active = new Set<string>();
  private readonly writer: JsonFileWriter;
  private readonly change: KernelChange;

  constructor(
    private readonly base: ServerConfig,
    private readonly deps: PluginManagerDeps,
  ) {
    this.switches = readPluginSettings(base.home);
    this.booted = { ...this.switches };
    this.writer = new JsonFileWriter(pluginSettingsFile(base.home));
    this.change = {
      prepare: () => this.deps.install(this.config(), this.deps.log),
      rollback: () => this.save(this.booted),
      changed: () => this.deps.changed(),
      messages: { applied: 'pluginsApplied', rolledBack: 'pluginsRolledBack', busy: 'pluginsApplyBusy' },
    };
  }

  /** The server config with the App's switches applied. */
  config(): ServerConfig {
    return withPluginSettings(this.base, this.switches);
  }

  /** The kernel wrote its profile with `config()` and is starting with these plugins. */
  loaded(plugins: ProfilePlugins): void {
    this.active = new Set(plugins.loaded);
    this.booted = { ...this.switches };
  }

  view(lang: Language): PluginsView {
    const overrides = this.config().plugins;
    const plugins = PLUGIN_MANIFEST.plugins.map((plugin) => this.pluginView(plugin, overrides, lang));
    return {
      plugins,
      unaudited: marketInstalls(profileDir(this.base)),
      pending: plugins.some((plugin) => plugin.enabled !== plugin.active),
      apply: this.deps.kernel.view(this.change, lang),
    };
  }

  private pluginView(plugin: Plugin, overrides: PluginSwitches, lang: Language): PluginView {
    const note = plugin.enabled ? undefined : pluginText(plugin.id, 'Note', lang);
    const homepage = 'repository' in plugin.source ? plugin.source.repository : undefined;
    return {
      id: plugin.id,
      title: pluginText(plugin.id, 'Title', lang) ?? plugin.id,
      summary: pluginText(plugin.id, 'Summary', lang) ?? '',
      ...(note ? { note } : {}),
      enabled: isEnabled(plugin, overrides),
      recommended: plugin.enabled,
      active: this.active.has(plugin.id),
      locked: plugin.id in this.base.pluginLocks,
      license: plugin.license,
      ...(homepage ? { homepage } : {}),
    };
  }

  /** Save one switch. It takes effect at the next apply. */
  async set(id: string, enabled: boolean): Promise<void> {
    if (!PLUGIN_MANIFEST.plugins.some((plugin) => plugin.id === id)) throw new ServerFailure(text('pluginUnknown', id));
    if (id in this.base.pluginLocks) throw new ServerFailure(text('pluginLockedByServer', id));
    await this.save({ ...this.switches, [id]: enabled });
    this.deps.changed();
  }

  private save(switches: PluginSwitches): Promise<void> {
    return this.writer.write({ plugins: switches }, () => {
      this.switches = switches;
    });
  }

  get busy(): boolean {
    return this.deps.kernel.busy;
  }

  /** Install what the switches need and restart the kernel, in the background. */
  apply(): void {
    this.deps.kernel.start(this.change);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
