/** The plugin page's wire types: `GET /swiftnest/api/plugins` and the switch and apply answers. */
export type ApplyState = 'idle' | 'installing' | 'restarting' | 'failed';

export interface PluginView {
  id: string;
  /** Localized name, one-line description and, for plugins off by default, what to know first. */
  title: string;
  summary: string;
  note?: string;
  enabled: boolean;
  /** On by default: audited and safe without setup. */
  recommended: boolean;
  /** Loaded by the running kernel. */
  active: boolean;
  /** Set by the administrator (SWIFTNEST_PLUGINS); the App shows it read-only. */
  locked: boolean;
  license: string;
  homepage?: string;
}

export interface PluginsView {
  plugins: PluginView[];
  /** Packages installed from the community market, which Swiftnest has not audited. */
  unaudited: string[];
  /** A switch differs from what the running kernel loaded; apply to install and restart. */
  pending: boolean;
  apply: {
    state: ApplyState;
    /** The last apply failed and the previous plugins were restored. */
    rolledBack?: boolean;
    error?: { code: string; message: string; hint: string };
  };
}
