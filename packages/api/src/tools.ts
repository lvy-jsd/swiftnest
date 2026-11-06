import type { PluginsView } from './plugins.js';

/** Metadata comes from the installed Tool Ultra catalog; secrets never cross the API. */
export interface McpPresetView {
  id: string;
  title: string;
  summary: string;
  category: string;
  source: string;
  license: string;
  /** Missing settings, with the upstream explanation of where to obtain them. */
  needs: { env: string; hint: string }[];
  state: 'on' | 'off' | 'needs-key';
  enabled: boolean;
}
export interface CapabilityPackView {
  name: string;
  targets: string[];
}
export interface ToolsView {
  presets: McpPresetView[];
  packs: CapabilityPackView[];
  pending: boolean;
  apply: PluginsView['apply'];
}
