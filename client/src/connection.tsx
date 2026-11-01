import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import { SwiftnestClient } from '@swiftnest/api';
import type { ClientOptions, SessionSummary } from '@swiftnest/api';
import { isTauriRuntime } from './runtime';

type Status = 'disconnected' | 'connecting' | 'connected';
export type ConnectionError = 'pairFailed' | 'sameOrigin' | 'loadFailed' | 'connectionLost';
export interface ConnectionState {
  status: Status;
  root: string;
  sessions: SessionSummary[];
  error?: ConnectionError;
}
export const ROOT_KEY = 'swiftnest.serverRoot';
export function serverRoot(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.pathname.endsWith('/connect') || !url.searchParams.get('token')) throw new Error('Invalid pairing URL');
  return new URL('./', url).href;
}
function rememberedRoot(): string {
  try {
    const value = localStorage.getItem(ROOT_KEY);
    if (!value) return '';
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.href : '';
  } catch { return ''; }
}
export async function clientOptions(): Promise<ClientOptions> {
  if (isTauriRuntime()) return (await import('./nativeTransport')).nativeOptions();
  return { cookieMode: 'browser' };
}

/** One ephemeral client. Pairing again cancels and disposes the previous attempt. */
export class ConnectionStore {
  client?: SwiftnestClient;
  private generation = 0;
  private listeners = new Set<() => void>();
  private state: ConnectionState = { status: 'disconnected', root: rememberedRoot(), sessions: [] };
  constructor(private options = clientOptions, private create = (options: ClientOptions) => new SwiftnestClient(options)) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ConnectionState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  async pair(url: string): Promise<boolean> {
    this.disconnect();
    const generation = this.generation;
    this.update({ status: 'connecting', error: undefined });
    let candidate: SwiftnestClient | undefined;
    try {
      const root = serverRoot(url);
      if (!isTauriRuntime() && typeof location !== 'undefined' && new URL(root).origin !== location.origin) {
        this.update({ status: 'disconnected', error: 'sameOrigin' }); return false;
      }
      const options = await this.options();
      if (generation !== this.generation) return false;
      const factory = options.createWebSocket ?? ((address: string) => new WebSocket(address));
      candidate = this.create({ ...options, createWebSocket: (address, init) => {
        const socket = factory(address, init);
        const lost = () => {
          if (generation !== this.generation || this.state.status !== 'connected') return;
          this.disconnect();
          this.update({ error: 'connectionLost' });
        };
        socket.addEventListener('close', lost, { once: true });
        socket.addEventListener('error', lost, { once: true });
        return socket;
      } });
      this.client = candidate;
      await candidate.connect(url);
      if (generation !== this.generation) { candidate.close(); return false; }
      this.update({ status: 'connected', root, error: undefined });
      try { localStorage.setItem(ROOT_KEY, root); } catch { /* Storage can be disabled. */ }
      await this.refresh();
      return generation === this.generation;
    } catch {
      candidate?.close();
      if (generation === this.generation) { this.client = undefined; this.update({ status: 'disconnected', error: 'pairFailed' }); }
      return false;
    }
  }
  async refresh(): Promise<void> {
    const client = this.client;
    if (!client || this.state.status !== 'connected') return;
    try {
      const sessions = await client.listSessions();
      if (client === this.client) this.update({ sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), error: undefined });
    } catch { if (client === this.client) this.update({ error: 'loadFailed' }); }
  }
  async newChat(): Promise<string | undefined> {
    const client = this.client;
    if (!client || this.state.status !== 'connected') return;
    try {
      const { sessionId } = await client.createSession();
      if (client !== this.client) return;
      await this.refresh();
      return client === this.client ? sessionId : undefined;
    } catch { if (client === this.client) this.update({ error: 'loadFailed' }); }
  }
  disconnect(): void {
    ++this.generation;
    const previous = this.client;
    this.client = undefined;
    previous?.close();
    this.update({ status: 'disconnected', sessions: [], error: undefined });
  }
}
const Context = createContext<ConnectionStore | null>(null);
export function ConnectionProvider({ children, store: supplied }: PropsWithChildren<{ store?: ConnectionStore }>) {
  const [store] = useState(() => supplied ?? new ConnectionStore());
  const lifetime = useRef(0);
  useEffect(() => {
    const generation = ++lifetime.current;
    return () => { queueMicrotask(() => { if (lifetime.current === generation) store.disconnect(); }); };
  }, [store]);
  return <Context value={store}>{children}</Context>;
}
export function useConnection() {
  const store = useContext(Context);
  if (!store) throw new Error('ConnectionProvider is required');
  return { store, ...useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) };
}
