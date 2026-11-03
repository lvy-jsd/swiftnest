import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { ApiError, localizedError, type PluginsView, type PluginView } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { applyBusy, applyMessage, orderedPlugins, toggleDecision } from './pluginState';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { HubPage, SheetPage } from './components/pages';

type Plugins = {
  owner: boolean;
  view?: PluginsView;
  busy: boolean;
  failed: boolean;
  act: (action: () => Promise<PluginsView>) => Promise<boolean>;
};
const Context = createContext<Plugins | null>(null);
type RefreshOptions = {
  client?: import('@swiftnest/api').SwiftnestClient;
  store: import('./connection').ConnectionStore;
  locale: string;
  pluginRestart?: string;
  revision: { current: number };
  mutating: { current: boolean };
  setView: (view: PluginsView | undefined) => void;
  setOwner: (client: RefreshOptions['client']) => void;
  setFailed: (failed: boolean) => void;
};
function watchPluginChanges(client: NonNullable<RefreshOptions['client']>, refresh: () => Promise<void>) {
  const abort = new AbortController();
  let retry: ReturnType<typeof setTimeout>;
  async function watch() {
    try {
      const events = await client.watchDevices({ signal: abort.signal });
      await refresh();
      for await (const event of events) {
        if (abort.signal.aborted) break;
        if (event.type === 'plugins-changed') await refresh();
      }
    } catch {
      // Polling also recovers a missed push or a brief restart.
    }
    if (!abort.signal.aborted) retry = setTimeout(() => void watch(), 1500);
  }
  void watch();
  const poll = setInterval(() => void refresh(), 2000);
  return () => {
    abort.abort();
    clearInterval(poll);
    clearTimeout(retry);
  };
}
function usePluginRefresh(options: RefreshOptions) {
  const { client, store, locale, pluginRestart, revision, mutating, setView, setOwner, setFailed } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: server prose needs re-reading after a language change
  useEffect(() => {
    if (!client) {
      if (!pluginRestart) {
        setView(undefined);
        setOwner(undefined);
      }
      return;
    }
    let ended = false;
    let reading = false;
    async function refresh() {
      if (reading || mutating.current) return;
      reading = true;
      const version = revision.current;
      try {
        const next = await client!.listPlugins();
        if (ended || version !== revision.current) return;
        setView(next);
        setOwner(client);
        setFailed(false);
        store.expectPluginRestart(applyBusy(next));
      } catch (error) {
        if (!ended) {
          setFailed(true);
          if (error instanceof ApiError && [401, 403].includes(error.httpStatus ?? 0)) {
            setOwner(undefined);
            setView(undefined);
          }
        }
      } finally {
        reading = false;
      }
    }
    void refresh();
    const stop = watchPluginChanges(client, refresh);
    return () => {
      ended = true;
      stop();
    };
  }, [client, store, locale, pluginRestart, revision, mutating, setView, setOwner, setFailed]);
}
export function PluginsProvider({ children }: PropsWithChildren) {
  const { store, status, pluginRestart } = useConnection();
  const { locale } = useI18n();
  const client = status === 'connected' ? store.client : undefined;
  const [view, setView] = useState<PluginsView>();
  const [authorizedClient, setOwner] = useState<RefreshOptions['client']>();
  const owner = !!authorizedClient && (authorizedClient === client || !!pluginRestart);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const revision = useRef(0);
  const mutating = useRef(false);
  usePluginRefresh({ client, store, locale, pluginRestart, revision, mutating, setView, setOwner, setFailed });
  async function act(action: () => Promise<PluginsView>) {
    if (!client || mutating.current) return false;
    mutating.current = true;
    ++revision.current;
    setBusy(true);
    try {
      const next = await action();
      if (store.client !== client) return false;
      setView(next);
      setFailed(false);
      store.expectPluginRestart(applyBusy(next));
      return true;
    } catch {
      if (store.client === client) {
        setFailed(true);
        store.expectPluginRestart(applyBusy(view));
      }
      return false;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  return <Context value={{ owner, view, busy, failed, act }}>{children}</Context>;
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
export function PluginApplyStatus({ view, restarting = false }: { view: PluginsView; restarting?: boolean }) {
  const { t, locale } = useI18n();
  const progress = applyMessage(view);
  const failure =
    view.apply.state === 'failed' && !view.apply.rolledBack && view.apply.error
      ? localizedError(view.apply.error, locale)
      : undefined;
  if (!progress && !restarting && !failure) return null;
  return (
    <Card className="plugin-apply" role={failure ? 'alert' : 'status'}>
      {restarting ? t('pluginsRestarting') : progress ? t(progress) : null}
      {failure && (
        <>
          <p>{failure.message}</p>
          <p>{failure.hint}</p>
        </>
      )}
    </Card>
  );
}
function PluginApply() {
  const { view, busy, act } = usePlugins();
  const { store, pluginRestart, status } = useConnection();
  const { t } = useI18n();
  if (!view) return null;
  const apply = () => {
    store.expectPluginRestart(true);
    void act(() => store.client!.applyPlugins());
  };
  if (pluginRestart === 'pair-required')
    return (
      <Card className="plugin-apply" role="status">
        <h2>{t('pluginsPairRequired')}</h2>
        <p>{t('pluginsPairHelp')}</p>
        <a className="button button--primary" href="#/pair?return=plugins">
          {t('pluginsReconnect')}
        </a>
      </Card>
    );
  return (
    <>
      <PluginApplyStatus view={view} restarting={!!pluginRestart} />
      {(view.pending || view.apply.state === 'failed') && !pluginRestart && (
        <Card className="plugin-apply">
          <p>{t('pluginsApplyHelp')}</p>
          <Button variant="primary" disabled={busy || applyBusy(view) || status !== 'connected'} onClick={apply}>
            {t(view.apply.state === 'failed' ? 'pluginsRetry' : 'pluginsApply')}
          </Button>
        </Card>
      )}
    </>
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
  const [confirm, setConfirm] = useState<PluginView>();
  const disabled = busy || applyBusy(view) || status !== 'connected';
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
          <PluginApply />
          {failed && status === 'connected' && <p role="alert">{t('pluginsRequestFailed')}</p>}
          {orderedPlugins(view.plugins).map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} disabled={disabled} toggle={() => toggle(plugin)} />
          ))}
          <CommunityPlugins packages={view.unaudited} />
        </>
      ) : (
        <p role="status">{t(failed ? 'pluginsOwnerOnly' : 'pluginsLoading')}</p>
      )}
      <PluginConfirmation plugin={confirm} disabled={disabled} save={save} close={() => setConfirm(undefined)} />
    </HubPage>
  );
}
