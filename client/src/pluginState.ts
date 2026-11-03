import type { ApplyState, PluginView } from '@swiftnest/api';

/** A settings view whose changes take effect by restarting the assistant. */
export type Applyable = { pending: boolean; apply: { state: ApplyState; rolledBack?: boolean } };

export function orderedPlugins(plugins: PluginView[]): PluginView[] {
  return [...plugins].sort((a, b) => Number(b.recommended) - Number(a.recommended));
}
export function toggleDecision(plugin: PluginView): 'locked' | 'confirm' | 'save' {
  if (plugin.locked) return 'locked';
  return !plugin.enabled && (plugin.note || plugin.id === 'market') ? 'confirm' : 'save';
}
export function applyBusy(view?: Applyable): boolean {
  return view?.apply.state === 'installing' || view?.apply.state === 'restarting';
}
/** Which progress line an apply shows; each page words them for its own change. */
export function applyProgress(view: Applyable): 'preparing' | 'restarting' | 'restored' | undefined {
  if (view.apply.state === 'installing') return 'preparing';
  if (view.apply.state === 'restarting') return 'restarting';
  if (view.apply.state === 'failed' && view.apply.rolledBack) return 'restored';
  return undefined;
}
