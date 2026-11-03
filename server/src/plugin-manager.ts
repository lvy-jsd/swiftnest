/**
 * What the App's plugin page drives: the audited plugins and their switches, community
 * market installs (labelled unaudited), and applying changes, which installs what is
 * missing and restarts the DSH kernel. If the kernel cannot start with the new plugins,
 * the switches go back to the last ones that booted, so a novice is never left without
 * a running server.
 */
import type { ApplyState, PluginsView, PluginView } from '@swiftnest/api';
import { isText, text } from '@swiftnest/core';
import type { Log } from './command.js';
import type { ServerConfig } from './config.js';
import { localizedError, message, ServerFailure } from './i18n.js';
import { JsonFileWriter } from './json-store.js';
import type { Language } from './preferences.js';
import { type PluginSwitches, pluginSettingsFile, readPluginSettings, withPluginSettings } from './plugin-settings.js';
import { isEnabled, PLUGIN_MANIFEST, type Plugin } from './plugins.js';
import { marketInstalls, type ProfilePlugins } from './profile-plugins.js';
import { profileDir } from './profile.js';

export interface PluginManagerDeps {
  install(config: ServerConfig, log: Log): Promise<void>;
  /** Restart the DSH kernel; it reads `config()` and reports back through `loaded()`. */
  restart(): Promise<void>;
  /** The kernel could not start even with the previous plugins. */
  fail(error: unknown): void;
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
  private state: ApplyState = 'idle';
  private failure?: unknown;
  private rolledBack = false;
  private readonly writer: JsonFileWriter;

  constructor(
    private readonly base: ServerConfig,
    private readonly deps: PluginManagerDeps,
  ) {
    this.switches = readPluginSettings(base.home);
    this.booted = { ...this.switches };
    this.writer = new JsonFileWriter(pluginSettingsFile(base.home));
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
      apply: {
        state: this.state,
        ...(this.rolledBack ? { rolledBack: true } : {}),
        ...(this.failure === undefined ? {} : { error: localizedError(this.failure, lang) }),
      },
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
    return this.state === 'installing' || this.state === 'restarting';
  }

  /** Install what the switches need and restart the kernel, in the background. */
  apply(): void {
    if (this.busy) throw new ServerFailure(text('pluginsApplyBusy'));
    this.failure = undefined;
    this.rolledBack = false;
    this.setState('installing');
    void this.run();
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  private async run(): Promise<void> {
    try {
      await this.deps.install(this.config(), this.deps.log);
      this.setState('restarting');
      await this.deps.restart();
      this.deps.log(message('pluginsApplied', this.base.lang));
      this.setState('idle');
    } catch (error) {
      this.failure = error;
      if (this.state === 'restarting') await this.rollback();
      this.setState('failed');
    }
  }

  /** The kernel did not come back with the new plugins: restore the switches it last booted with. */
  private async rollback(): Promise<void> {
    this.rolledBack = true;
    this.deps.log(message('pluginsRolledBack', this.base.lang));
    try {
      await this.save(this.booted);
      await this.deps.restart();
    } catch (error) {
      this.deps.fail(error);
    }
  }

  private setState(state: ApplyState): void {
    this.state = state;
    this.deps.changed();
  }
}
