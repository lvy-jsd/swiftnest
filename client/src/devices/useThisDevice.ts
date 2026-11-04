import { useEffect, useState } from 'react';
import type { Text } from '@swiftnest/api';
import { useConnection } from '../connection';
import { isTauriRuntime } from '../runtime';

export type PerchSettings = {
  name: string;
  slug: string;
  enabled: boolean;
  background: boolean;
  allowLiveView?: boolean;
  roots: string[];
  url: string;
  nestKey: string | null;
};
export type PerchSnapshot = {
  settings: PerchSettings;
  phase: string;
  fingerprint: string;
  nestFingerprint: string | null;
  confirmationPending: boolean;
  /** English prose plus catalog text, rendered in the App's language. */
  error: { code: string; message: string; text?: Text } | null;
  platform: 'desktop' | 'android' | 'ios';
  watching?: boolean;
  ownerControl?: boolean;
};
export function perchAddress(root: string): string {
  try {
    const url = new URL(root);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.port = '7711';
    url.pathname = '/swiftnest';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}
export async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}
function usePerchSnapshot() {
  const { root, store } = useConnection();
  const [snapshot, setSnapshot] = useState<PerchSnapshot>();
  const [draft, setDraft] = useState<PerchSettings>();
  /** What the last native call threw, if it failed. */
  const [failure, setFailure] = useState<{ error: unknown }>();
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const read = async () => {
      try {
        const value = await native<PerchSnapshot>('perch_snapshot');
        if (disposed) return;
        setSnapshot(value);
        setDraft((previous) => previous ?? { ...value.settings, url: value.settings.url || perchAddress(root) });
      } catch (error) {
        if (!disposed) setFailure({ error });
      }
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [root]);
  return { snapshot, setSnapshot, draft, setDraft, failure, setFailure, store };
}

export function useThisDevice() {
  const { snapshot, setSnapshot, draft, setDraft, failure, setFailure, store } = usePerchSnapshot();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [unpair, setUnpair] = useState(false);
  const phone = snapshot?.platform === 'android';
  const shownFailure = failure?.error ?? snapshot?.error;
  // Desktop needs shared folders before it can be enabled; the phone uses the App's own folder.
  const foldersReady = phone || !!draft?.roots.length;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
      setSnapshot(await native<PerchSnapshot>('perch_snapshot'));
    } catch (error) {
      setFailure({ error });
    } finally {
      setBusy(false);
    }
  };
  const save = (settings = draft, pairingCode?: string) =>
    act(async () => {
      if (!settings) return;
      const value = await native<PerchSnapshot>('perch_configure', { settings, code: pairingCode ?? null });
      setSnapshot(value);
      setDraft(value.settings);
      if (pairingCode) setCode('');
    });
  return {
    snapshot,
    draft,
    setDraft,
    code,
    setCode,
    busy,
    shownFailure,
    unpair,
    setUnpair,
    phone,
    foldersReady,
    act,
    save,
    store,
  };
}
export type ThisDeviceState = ReturnType<typeof useThisDevice> & { snapshot: PerchSnapshot; draft: PerchSettings };
