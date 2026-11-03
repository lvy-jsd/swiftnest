import type { PluginsView, PluginView } from '@swiftnest/api';

export function orderedPlugins(plugins: PluginView[]): PluginView[] {
  return [...plugins].sort((a, b) => Number(b.recommended) - Number(a.recommended));
}
export function toggleDecision(plugin: PluginView): 'locked' | 'confirm' | 'save' {
  if (plugin.locked) return 'locked';
  return !plugin.enabled && (plugin.note || plugin.id === 'market') ? 'confirm' : 'save';
}
export function applyBusy(view?: PluginsView): boolean {
  return view?.apply.state === 'installing' || view?.apply.state === 'restarting';
}
export function applyMessage(
  view: PluginsView,
): 'pluginsPreparing' | 'pluginsRestarting' | 'pluginsRestored' | undefined {
  if (view.apply.state === 'installing') return 'pluginsPreparing';
  if (view.apply.state === 'restarting') return 'pluginsRestarting';
  if (view.apply.state === 'failed' && view.apply.rolledBack) return 'pluginsRestored';
  return undefined;
}
