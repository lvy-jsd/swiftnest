import type { MemoryView } from '@swiftnest/api';

export interface MemoryState {
  view: MemoryView;
  busy: boolean;
  error?: unknown;
}
export type MemoryAction =
  | { type: 'start' }
  | { type: 'loaded'; view: MemoryView }
  | { type: 'failed'; error: unknown };
export const initialMemoryState: MemoryState = { view: { entries: [], topics: [] }, busy: false };

export function memoryReducer(state: MemoryState, action: MemoryAction): MemoryState {
  switch (action.type) {
    case 'start':
      return { ...state, busy: true, error: undefined };
    case 'loaded':
      return { view: action.view, busy: false };
    case 'failed':
      return { ...state, busy: false, error: action.error };
  }
}

/** Reconnect and re-read after reconnect so a missed change cannot leave stale memory. */
export function watchMemoryChanges(client: import('@swiftnest/api').SwiftnestClient, refresh: () => Promise<void>) {
  const abort = new AbortController();
  let retry: ReturnType<typeof setTimeout>;
  async function watch() {
    try {
      const events = await client.watchDevices({ signal: abort.signal });
      await refresh();
      for await (const event of events) {
        if (abort.signal.aborted) break;
        if (event.type === 'memory-changed') await refresh();
      }
    } catch {
      // A brief restart closes the stream; re-read once it reconnects.
    }
    if (!abort.signal.aborted) retry = setTimeout(() => void watch(), 1500);
  }
  void watch();
  return () => {
    abort.abort();
    clearTimeout(retry);
  };
}
