import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import type { Device, DevicePairingCandidate, SwiftnestClient, Transfer } from '@swiftnest/api';
import { useConnection } from '../connection';

type HubData = {
  transfers: Transfer[];
  devices: Device[];
  candidates: DevicePairingCandidate[];
};
type Hub = HubData & { error: boolean; busy: boolean; act: (action: () => Promise<unknown>) => Promise<boolean> };
const empty: HubData = { transfers: [], devices: [], candidates: [] };
const Context = createContext<Hub | null>(null);

export function useDeviceWatch(
  client: SwiftnestClient | undefined,
  refresh: () => Promise<void>,
  fail: () => void,
  kind: 'devices' | 'approvals' = 'devices',
) {
  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const sync = () =>
      refresh().catch(() => {
        if (!abort.signal.aborted) fail();
      });
    // Snapshots also recover expired candidates and a dropped push.
    const poll = setInterval(() => void sync(), 15_000);
    void sync();
    async function watch() {
      try {
        const stream = await (kind === 'approvals'
          ? client!.watchApprovals({ signal: abort.signal })
          : client!.watchDevices({ signal: abort.signal }));
        await sync();
        for await (const _ of stream) {
          if (abort.signal.aborted) break;
          await sync();
        }
      } catch {
        if (!abort.signal.aborted) fail();
      }
      if (!abort.signal.aborted) retry = setTimeout(() => void watch(), 1500);
    }
    void watch();
    return () => {
      abort.abort();
      clearInterval(poll);
      clearTimeout(retry);
    };
  }, [client, refresh, fail, kind]);
}

function useHubData() {
  const { store, status } = useConnection();
  const client = status === 'connected' ? store.client : undefined;
  const [data, setData] = useState(empty);
  const [error, setError] = useState(false);
  const version = useRef(0);
  const fail = useCallback(() => setError(true), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each client identity starts a new snapshot generation
  useEffect(() => {
    // Invalidates pending snapshots, including disconnects from the same client.
    version.current++;
    setData(empty);
    setError(false);
  }, [client]);
  const refresh = useCallback(async () => {
    if (!client) return;
    const current = ++version.current;
    const [devices, candidates, transfers] = await Promise.all([
      client.listDevices(),
      client.listDevicePairings(),
      client.listTransfers(),
    ]);
    if (store.client !== client || current !== version.current) return;
    await store.updateDeviceContext(devices);
    if (store.client !== client || current !== version.current) return;
    setData({ devices, candidates, transfers });
    setError(false);
  }, [client, store]);
  useDeviceWatch(client, refresh, fail);
  return { data, error, fail, refresh, client, store };
}

export function DeviceHubProvider({ children }: PropsWithChildren) {
  const { data, error, fail, refresh, client, store } = useHubData();
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      return true;
    } catch {
      if (store.client === client) fail();
      return false;
    } finally {
      setBusy(false);
    }
  };
  return <Context value={{ ...data, error, busy, act }}>{children}</Context>;
}
export function useDevices() {
  const value = useContext(Context);
  if (!value) throw new Error('DeviceHubProvider required');
  return value;
}
