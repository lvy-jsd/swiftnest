import { text } from '@swiftnest/core';
import { message, ServerFailure } from './i18n.js';
import { type ProfilePlugins, profilePlugins } from './profile-plugins.js';
/**
 * The `swiftnest` DSH profile: DSH's own base and web bundles, then ours, then
 * a patch layer generated from the Swiftnest config. The profile is rewritten
 * on every start, except `user.patch.yml`, which belongs to the operator.
 */
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readlinkSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import type { ModelRoute } from '@swiftnest/api';
import type { ServerConfig } from './config.js';
import { LOCAL_PROVIDER, modelKeyEnv } from './model-settings.js';

export const PROFILE_NAME = 'swiftnest';
export const BUNDLE_PACKAGE = '@swiftnest/server-bundle';
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BUNDLE_PACKAGE] as const;
/** Provider id inside DSH for the configured model endpoint. */
export const PROVIDER_ID = 'swiftnest-local';

export function dshHome(config: ServerConfig): string {
  return join(config.home, 'dsh');
}

export function profileDir(config: ServerConfig): string {
  return join(dshHome(config), 'profiles', PROFILE_NAME);
}

/** The patch rows Swiftnest owns: model providers, the default model and the expert. */
export function modelPatch(config: ServerConfig): unknown[] {
  const main = dshRoute(config, config.cloud?.main);
  return [
    { id: 'llm-pi-ai', config: { providers: { [PROVIDER_ID]: localProvider(config), ...cloudProviders(config) } } },
    { id: 'agent-default-model', config: main },
    ...expertRows(config),
  ];
}

function localProvider(config: ServerConfig) {
  const m = config.model;
  return {
    displayName: m.name,
    api: 'openai-completions',
    apiKeyEnv: m.apiKeyEnv,
    baseURL: m.baseUrl,
    models: [{ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: ['text'] }],
  };
}

/** A route as DSH names it: the local model is the `swiftnest-local` provider. */
function dshRoute(config: ServerConfig, route: ModelRoute | undefined): ModelRoute {
  return !route || route.provider === LOCAL_PROVIDER ? { provider: PROVIDER_ID, model: config.model.id } : route;
}

/** Catalog providers need only their key and the models in use; the catalog supplies the rest. */
function cloudProviders(config: ServerConfig): Record<string, unknown> {
  const providers: Record<string, { apiKeyEnv: string; models: { id: string }[] }> = {};
  for (const route of [config.cloud?.main, config.cloud?.expert]) {
    if (!route || route.provider === LOCAL_PROVIDER) continue;
    providers[route.provider] ??= { apiKeyEnv: modelKeyEnv(route.provider), models: [] };
    const provider = providers[route.provider]!;
    if (!provider.models.some((model) => model.id === route.model)) provider.models.push({ id: route.model });
  }
  return providers;
}

export const EXPERT_TOOL = 'ask_expert';

/** The expert is DSH's own subagent tool pinned to the expert model, plus Swiftnest's routing rules. */
function expertRows(config: ServerConfig): unknown[] {
  const cloud = config.cloud;
  if (!cloud?.expert) return [];
  const expert = dshRoute(config, cloud.expert);
  return [
    {
      insert: [
        {
          id: 'swiftnest-expert',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'spawn', toolName: EXPERT_TOOL, agentOptions: expert },
        },
        {
          id: 'swiftnest-routing',
          name: `${BUNDLE_PACKAGE}/routing`,
          config: { tool: EXPERT_TOOL, model: expert.model, approval: cloud.expertApproval },
        },
      ],
    },
  ];
}

/** DSH uses !!js for deferred expressions. Treat them as inert strings, never evaluate them. */
const presetTags = [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }];

/**
 * Turn inserted preset declarations into overrides. A Cordis override replaces
 * the entire config, so retain the original source (including tags, comments,
 * scalar styles and expressions), changing only persona prefix scalar spans.
 */
export function presetPersonaPatch(source: string, persona: string): string {
  const doc = parseDocument(source, { customTags: presetTags });
  if (doc.errors.length) throw new ServerFailure(text('invalidDshPresetPatch', doc.errors[0]!.message));
  if (!isSeq(doc.contents)) return '';
  const overrides: string[] = [];
  for (const entry of doc.contents.items) {
    if (!isMap(entry)) continue;
    const inserted = entry.get('insert', true);
    const rows = isSeq(inserted) ? inserted.items : [entry];
    for (const row of rows) {
      if (
        !isMap(row) ||
        row.flow ||
        !row.range ||
        typeof row.get('id') !== 'string' ||
        row.get('name') !== '@deepseek-ai/dsh-agent-preset'
      )
        continue;
      const plugins = row.getIn(['config', 'plugins'], true);
      if (!isSeq(plugins)) continue;
      const edits: { start: number; end: number; value: string }[] = [];
      for (const plugin of plugins.items) {
        if (!isMap(plugin) || plugin.get('id') !== 'persona' || plugin.get('name') !== '@deepseek-ai/dsh-persona')
          continue;
        const prefix = plugin.getIn(['config', 'prefix'], true);
        if (!isScalar(prefix) || typeof prefix.value !== 'string' || prefix.tag || !prefix.range) continue;
        const [start, end] = prefix.range;
        // JSON strings are YAML double-quoted scalars, including multiline or
        // YAML-looking operator text. Block scalars include their final newline.
        edits.push({ start, end, value: JSON.stringify(persona) + (source[end - 1] === '\n' ? '\n' : '') });
      }
      if (!edits.length) continue;
      const [start, , end] = row.range;
      const lineStart = source.lastIndexOf('\n', start - 1) + 1;
      const indent = start - lineStart - 2; // exclude the sequence's "- "
      if (indent < 0 || source.slice(lineStart, start) !== `${' '.repeat(indent)}- `) continue;
      let text = source.slice(start, end);
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        text = text.slice(0, edit.start - start) + edit.value + text.slice(edit.end - start);
      }
      // Remove just the insert wrapper's indentation; leave all row bytes intact.
      text = `- ${text.replace(new RegExp(`^ {${indent}}`, 'gm'), '')}`;
      overrides.push(text.endsWith('\n') ? text : `${text}\n`);
    }
  }
  return overrides.join('');
}

/** Resolve from DSH's install, not a potentially different top-level web bundle. */
function installedPresetPatch(persona: string): string {
  const require = createRequire(import.meta.url);
  const dshPackage = require.resolve('@deepseek-ai/dsh/package.json');
  const webPackage = createRequire(dshPackage).resolve('@deepseek-ai/dsh-web-app/package.json');
  const presets = join(dirname(webPackage), 'presets');
  return readdirSync(presets)
    .filter((file) => file.endsWith('.patch.yml'))
    .sort()
    .map((file) => presetPersonaPatch(readFileSync(join(presets, file), 'utf8'), persona))
    .join('');
}

export interface WriteProfileOptions {
  /** Directory of the installed `@swiftnest/server-bundle` package. */
  bundleDir: string;
  log?: (line: string) => void;
}

/**
 * Third-party plugins install with pnpm into the profile. Dependency build
 * scripts are denied unless listed; none of the pinned plugins needs one.
 */
const PROFILE_WORKSPACE = 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: false\n';

function reportPlugins(plugins: ProfilePlugins, config: ServerConfig, log: (line: string) => void): void {
  const notes = [
    ['pluginsMissing', plugins.missing],
    ['pluginsUnaudited', plugins.unaudited],
    ['pluginsOutsideManifest', plugins.dropped],
  ] as const;
  for (const [key, names] of notes) if (names.length) log(message(key, config.lang, [names.join(', ')]));
}

/** Write the `swiftnest` profile; returns its directory and what the enabled plugins contributed. */
export function writeProfile(
  config: ServerConfig,
  opts: WriteProfileOptions,
): { dir: string; plugins: ProfilePlugins } {
  const dir = profileDir(config);
  const plugins = profilePlugins(config, dir);
  reportPlugins(plugins, config, opts.log ?? console.warn);
  mkdirSync(dir, { recursive: true });
  const pkg = {
    name: 'dsh-profile-swiftnest',
    private: true,
    dependencies: plugins.dependencies,
    dsh: { profile: { bundles: [...BUNDLES, ...plugins.bundles] } },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE);
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    '# Generated by Swiftnest Server from its config on every start. Do not edit;\n' +
      '# put your own rows in user.patch.yml next to this file.\n' +
      stringify([...modelPatch(config), { id: 'system-prompt', config: { personaPrefix: config.persona } }]) +
      installedPresetPatch(config.persona) +
      (plugins.rows.length ? stringify(plugins.rows) : ''),
  );
  const userPatch = join(dir, 'user.patch.yml');
  if (!existsSync(userPatch)) writeFileSync(userPatch, '# Your own DSH patch rows, applied last.\n[]\n');
  linkBundle(dir, opts.bundleDir);
  return { dir, plugins };
}

/** Bundles resolve from the profile's node_modules after DSH's own install. */
function linkBundle(dir: string, bundleDir: string): void {
  const link = join(dir, 'node_modules', ...BUNDLE_PACKAGE.split('/'));
  mkdirSync(dirname(link), { recursive: true });
  let current: string | undefined;
  try {
    current = readlinkSync(link);
  } catch {
    current = undefined;
  }
  if (current === bundleDir) return;
  rmSync(link, { recursive: true, force: true });
  symlinkSync(bundleDir, link, 'dir');
}
