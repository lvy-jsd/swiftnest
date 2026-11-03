/**
 * Owner-only settings pages (plugins, models) read one view from the server, follow its
 * change event and save through `act`. A page's view carries the shared kernel apply
 * state, so the connection knows when to expect the restart and reconnect after it.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, type DeviceEvent, type SwiftnestClient } from '@swiftnest/api';
import { useConnection, type ConnectionStore } from './connection';
import { useI18n } from './i18n';
import { applyBusy, type Applyable } from './pluginState';

export type OwnerResource<V> = {
  owner: boolean;
  view?: V;
  busy: boolean;
  failed: boolean;
  act: (action: () => Promise<V>) => Promise<boolean>;
};

export type OwnerSource<V> = {
  read: (client: SwiftnestClient) => Promise<V>;
  /** The device event that says this view changed. */
  event: DeviceEvent['type'];
};

function watchChanges(client: SwiftnestClient, event: string, refresh: () => Promise<void>) {
  const abort = new AbortController();
  let retry: ReturnType<typeof setTimeout>;
  async function watch() {
    try {
      const events = await client.watchDevices({ signal: abort.signal });
      await refresh();
      for await (const next of events) {
        if (abort.signal.aborted) break;
        if (next.type === event) await refresh();
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

type RefreshState<V> = {
  client?: SwiftnestClient;
  store: ConnectionStore;
  locale: string;
  restarting?: string;
  revision: { current: number };
  mutating: { current: boolean };
  setView: (view: V | undefined) => void;
  setOwner: (client: SwiftnestClient | undefined) => void;
  setFailed: (failed: boolean) => void;
};

function useRefresh<V extends Applyable>(source: OwnerSource<V>, state: RefreshState<V>) {
  const { client, store, locale, restarting, revision, mutating, setView, setOwner, setFailed } = state;
  const { read, event } = source;
  // biome-ignore lint/correctness/useExhaustiveDependencies: server prose needs re-reading after a language change
  useEffect(() => {
    if (!client) {
      if (!restarting) {
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
        const next = await read(client!);
        if (ended || version !== revision.current) return;
        setView(next);
        setOwner(client);
        setFailed(false);
        store.expectPluginRestart(applyBusy(next));
      } catch (error) {
        if (ended) return;
        setFailed(true);
        if (error instanceof ApiError && [401, 403].includes(error.httpStatus ?? 0)) {
          setOwner(undefined);
          setView(undefined);
        }
      } finally {
        reading = false;
      }
    }
    void refresh();
    const stop = watchChanges(client, event, refresh);
    return () => {
      ended = true;
      stop();
    };
  }, [client, store, locale, restarting, revision, mutating, read, event, setView, setOwner, setFailed]);
}

/** One owner-only view, kept fresh while connected and through a kernel restart. */
export function useOwnerResource<V extends Applyable>(source: OwnerSource<V>): OwnerResource<V> {
  const { store, status, pluginRestart } = useConnection();
  const { locale } = useI18n();
  const client = status === 'connected' ? store.client : undefined;
  const [view, setView] = useState<V>();
  const [authorizedClient, setOwner] = useState<SwiftnestClient>();
  const owner = !!authorizedClient && (authorizedClient === client || !!pluginRestart);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const revision = useRef(0);
  const mutating = useRef(false);
  useRefresh(source, {
    client,
    store,
    locale,
    restarting: pluginRestart,
    revision,
    mutating,
    setView,
    setOwner,
    setFailed,
  });
  async function act(action: () => Promise<V>) {
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
  return { owner, view, busy, failed, act };
}
