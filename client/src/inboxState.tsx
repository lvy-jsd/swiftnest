import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import type { ApprovalInboxView } from '@swiftnest/api';
import { useConnection } from './connection';
import { useDeviceWatch } from './devices/hub';

interface InboxState {
  inbox?: ApprovalInboxView;
  busy: boolean;
  error: boolean;
  act(action: () => Promise<ApprovalInboxView>): Promise<void>;
}
const Context = createContext<InboxState | null>(null);
function useInboxData() {
  const { store, status } = useConnection();
  const client = status === 'connected' ? store.client : undefined;
  const [inbox, setInbox] = useState<ApprovalInboxView>();
  const [error, setError] = useState(false);
  const version = useRef(0);
  const mutating = useRef(false);
  const fail = useCallback(() => setError(true), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed client invalidates all in-flight snapshots
  useEffect(() => {
    version.current++;
    setInbox(undefined);
    setError(false);
  }, [client]);
  const refresh = useCallback(async () => {
    if (!client || mutating.current) return;
    const current = ++version.current;
    const next = await client.approvalInbox();
    if (store.client !== client || current !== version.current) return;
    setInbox(next);
    setError(false);
  }, [client, store]);
  useDeviceWatch(client, refresh, fail, 'approvals');
  return { inbox, error, setInbox, setError, client, store, version, mutating };
}
export function ApprovalInboxProvider({ children }: PropsWithChildren) {
  const { inbox, error, setInbox, setError, client, store, version, mutating } = useInboxData();
  const [busy, setBusy] = useState(false);
  async function act(action: () => Promise<ApprovalInboxView>) {
    if (!client || mutating.current) return;
    mutating.current = true;
    ++version.current;
    setBusy(true);
    try {
      const next = await action();
      if (store.client === client) {
        setInbox(next);
        setError(false);
      }
    } catch {
      if (store.client === client) setError(true);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  return <Context value={{ inbox, error, busy, act }}>{children}</Context>;
}
export function useApprovalInbox(): InboxState {
  const state = useContext(Context);
  if (!state) throw new Error('ApprovalInboxProvider required');
  return state;
}
