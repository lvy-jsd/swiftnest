import { createContext, useContext, useState } from 'react';
import type { PropsWithChildren } from 'react';
import type { PluginsView, PluginView } from '@swiftnest/api';
import { ToolsSection, toolsSource } from './tools';
import { ApplyPanel, type ApplyWords } from './applyPanel';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { useOwnerResource, type OwnerResource, type OwnerSource } from './ownerResource';
import { applyBusy, orderedPlugins, toggleDecision } from './pluginState';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { HubPage, SheetPage } from './components/pages';

const Context = createContext<OwnerResource<PluginsView> | null>(null);
const source: OwnerSource<PluginsView> = { read: (client) => client.listPlugins(), event: 'plugins-changed' };
export const pluginApplyWords: ApplyWords = {
  preparing: 'pluginsPreparing',
  restored: 'pluginsRestored',
  help: 'pluginsApplyHelp',
};
export function PluginsProvider({ children }: PropsWithChildren) {
  return <Context value={useOwnerResource(source)}>{children}</Context>;
}
export function usePlugins() {
  const value = useContext(Context);
  if (!value) throw new Error('PluginsProvider required');
  return value;
}

export function PluginCard({
  plugin,
  disabled,
  toggle,
}: {
  plugin: PluginView;
  disabled: boolean;
  toggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card className="plugin-card">
      <div className="plugin-card__row">
        <div>
          <h2>{plugin.title}</h2>
          <p>{plugin.summary}</p>
          {plugin.locked && (
            <p className="plugin-muted" id={`plugin-lock-${plugin.id}`}>
              {t('pluginsLocked')}
            </p>
          )}
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-label={plugin.title}
          checked={plugin.enabled}
          aria-checked={plugin.enabled}
          disabled={disabled || plugin.locked}
          onChange={toggle}
          aria-describedby={plugin.locked ? `plugin-lock-${plugin.id}` : undefined}
        />
      </div>
    </Card>
  );
}
export function CommunityPlugins({ packages }: { packages: string[] }) {
  const { t } = useI18n();
  if (!packages.length) return null;
  return (
    <section aria-label={t('pluginsCommunity')}>
      <h2>{t('pluginsCommunity')}</h2>
      {packages.map((name) => (
        <Card className="plugin-card" key={name}>
          <p>{name}</p>
          <small>{t('pluginsNotReviewed')}</small>
        </Card>
      ))}
    </section>
  );
}
function PluginConfirmation({
  plugin,
  disabled,
  save,
  close,
}: {
  plugin?: PluginView;
  disabled: boolean;
  save: (plugin: PluginView) => Promise<void>;
  close: () => void;
}) {
  const { t } = useI18n();
  return (
    <SheetPage
      open={!!plugin}
      title={plugin?.title ?? t('pluginsEnable')}
      onClose={close}
      actions={
        <>
          <Button onClick={close}>{t('pluginsCancel')}</Button>
          <Button variant="primary" disabled={disabled} onClick={() => plugin && void save(plugin)}>
            {t('pluginsEnable')}
          </Button>
        </>
      }
    >
      {plugin?.id === 'market' && <p className="plugin-warning">{t('pluginsMarketWarning')}</p>}
      <p>{plugin?.note}</p>
    </SheetPage>
  );
}
export function PluginsPage({ onBack }: { onBack: () => void }) {
  const { view, owner, busy, failed, act } = usePlugins();
  const { store, status } = useConnection();
  const { t } = useI18n();
  const tools = useOwnerResource(toolsSource);
  const [confirm, setConfirm] = useState<PluginView>();
  const disabled = busy || tools.busy || applyBusy(view) || applyBusy(tools.view) || status !== 'connected';
  const save = async (plugin: PluginView) => {
    if (await act(() => store.client!.setPluginEnabled(plugin.id, !plugin.enabled))) setConfirm(undefined);
  };
  const toggle = (plugin: PluginView) => {
    const decision = toggleDecision(plugin);
    if (decision === 'confirm') setConfirm(plugin);
    else if (decision === 'save') void save(plugin);
  };
  return (
    <HubPage title={t('pluginsTitle')} subtitle={t('pluginsHelp')} onBack={onBack}>
      {owner && view ? (
        <>
          <ApplyPanel
            view={view}
            words={pluginApplyWords}
            busy={busy || tools.busy}
            page="plugins"
            apply={() => void act(() => store.client!.applyPlugins())}
          />
          {failed && status === 'connected' && <p role="alert">{t('pluginsRequestFailed')}</p>}
          {orderedPlugins(view.plugins).map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} disabled={disabled} toggle={() => toggle(plugin)} />
          ))}
          <CommunityPlugins packages={view.unaudited} />
          <ToolsSection resource={tools} disabled={disabled} />
        </>
      ) : (
        <p role="status">{t(failed ? 'pluginsOwnerOnly' : 'pluginsLoading')}</p>
      )}
      <PluginConfirmation plugin={confirm} disabled={disabled} save={save} close={() => setConfirm(undefined)} />
    </HubPage>
  );
}
