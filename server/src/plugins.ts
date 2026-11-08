/**
 * The plugin manifest (`server/plugins.json`): every optional or third-party DSH
 * plugin the Server can load, pinned to one exact source, with its license. Modeled on
 * DeepSeek Harness Ultimate's audited profile: exact pins, a license allowlist,
 * and integrations that need credentials stay off until the operator enables them.
 */
import { text } from '@swiftnest/core';
import { readFileSync } from 'node:fs';
import { ServerFailure } from './i18n.js';

/** One owner-facing switch, installed atomically as exact audited npm packages. */
export interface NpmGroupSource {
  type: 'npm-group';
  repository: string;
  packages: Omit<NpmSource, 'type' | 'repository'>[];
}

export interface NpmSource {
  type: 'npm';
  repository: string;
  package: string;
  version: string;
  /** The registry tarball's Subresource Integrity hash, checked after installation. */
  integrity: string;
}

/** An optional bundle shipped with the pinned DSH kernel; its version is the kernel's. */
export interface DshSource {
  type: 'dsh';
  package: string;
}

export type Source = NpmGroupSource | NpmSource | DshSource;

export interface Plugin<S extends Source = Source> {
  id: string;
  license: string;
  /** The default; the operator's `plugins` config overrides it per id. */
  enabled: boolean;
  /** Why the plugin is off by default. */
  reason?: string;
  source: S;
  /** Profile patch rows applied while the plugin is enabled, e.g. its settings. */
  patch?: unknown[];
}

export interface PluginManifest {
  allowedLicenses: string[];
  plugins: Plugin[];
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const ID = /^[a-z][a-z0-9-]*$/;

const DSH_PACKAGE = /^@deepseek-ai\/dsh-[a-z0-9-]+$/;

function checkSource(id: string, source: Source): void {
  if (source.type === 'dsh') {
    if (!DSH_PACKAGE.test(source.package)) throw new ServerFailure(text('pluginSourceNotPinned', id));
    return;
  }
  if (source.type === 'npm-group') {
    const names = new Set<string>();
    if (!source.packages.length) throw new ServerFailure(text('pluginSourceNotPinned', id));
    for (const pkg of source.packages) {
      if (!/^@lvy-jsd\/dsh-tool-ultra-[a-z0-9-]+$/.test(pkg.package) || names.has(pkg.package))
        throw new ServerFailure(text('pluginSourceNotPinned', id));
      names.add(pkg.package);
      checkSource(id, { ...pkg, type: 'npm', repository: source.repository });
    }
    return;
  }
  if (!EXACT_VERSION.test(source.version) || !INTEGRITY.test(source.integrity))
    throw new ServerFailure(text('pluginSourceNotPinned', id));
}

/** Reject anything a reviewer could not reproduce: loose pins, unknown licenses, duplicate ids. */
export function checkManifest(manifest: PluginManifest): PluginManifest {
  const seen = new Set<string>();
  for (const plugin of manifest.plugins) {
    if (!ID.test(plugin.id) || seen.has(plugin.id)) throw new ServerFailure(text('pluginIdInvalid', plugin.id));
    seen.add(plugin.id);
    if (!manifest.allowedLicenses.includes(plugin.license))
      throw new ServerFailure(text('pluginLicenseNotAllowed', plugin.id, plugin.license));
    checkSource(plugin.id, plugin.source);
  }
  return manifest;
}

export const PLUGIN_MANIFEST: PluginManifest = checkManifest(
  JSON.parse(readFileSync(new URL('../plugins.json', import.meta.url), 'utf8')),
);

export function pluginById<S extends Source>(id: string, type: S['type']): Plugin<S> {
  const plugin = PLUGIN_MANIFEST.plugins.find((candidate) => candidate.id === id);
  if (plugin?.source.type !== type) throw new ServerFailure(text('pluginIdInvalid', id));
  return plugin as Plugin<S>;
}

/** Manifest defaults, overridden by the operator's `plugins` map. */
export function isEnabled(plugin: Plugin, overrides: Record<string, boolean>): boolean {
  return overrides[plugin.id] ?? plugin.enabled;
}

export function enabledPlugins<S extends Source>(overrides: Record<string, boolean>, type: S['type']): Plugin<S>[] {
  return PLUGIN_MANIFEST.plugins.filter(
    (plugin): plugin is Plugin<S> => plugin.source.type === type && isEnabled(plugin, overrides),
  );
}

export function enabledNpmPlugins(overrides: Record<string, boolean>): Plugin<NpmSource>[] {
  return PLUGIN_MANIFEST.plugins.flatMap((plugin): Plugin<NpmSource>[] => {
    if (!isEnabled(plugin, overrides)) return [];
    if (plugin.source.type === 'npm') return [plugin as Plugin<NpmSource>];
    if (plugin.source.type !== 'npm-group') return [];
    const repository = plugin.source.repository;
    return plugin.source.packages.map((pkg) => ({
      ...plugin,
      source: { ...pkg, type: 'npm', repository },
    }));
  });
}

/** Check operator overrides against the manifest so a typo never silently does nothing. */
export function checkOverrides(overrides: unknown): void {
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))
    throw new ServerFailure(text('pluginsMustMap'));
  for (const [id, value] of Object.entries(overrides)) {
    if (!PLUGIN_MANIFEST.plugins.some((plugin) => plugin.id === id)) throw new ServerFailure(text('pluginUnknown', id));
    if (typeof value !== 'boolean') throw new ServerFailure(text('pluginsMustMap'));
  }
}

/** The config file's `plugins` map, checked before it is merged with the environment. */
export function fileOverrides(value: unknown): Record<string, boolean> {
  if (value === undefined) return {};
  checkOverrides(value);
  return value as Record<string, boolean>;
}

/** `SWIFTNEST_PLUGINS=im=true,tool-ultra=false`; entries without `=false` enable. */
export function parsePluginsEnv(value: string | undefined): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const entry of (value ?? '').split(',')) {
    const [id, flag] = entry.trim().split('=');
    if (id) overrides[id] = flag !== 'false';
  }
  return overrides;
}
