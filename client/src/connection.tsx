import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import { ApiError, SwiftnestClient } from '@swiftnest/api';
import type { ChannelPairing, ClientOptions, Device, SessionSummary } from '@swiftnest/api';
import { isTauriRuntime } from './runtime';
import { SessionCache } from './sessionCache';

type Status = 'disconnected' | 'connecting' | 'connected';
export type ConnectionError =
  | 'pairFailed'
  | 'sameOrigin'
  | 'loadFailed'
  | 'connectionLost'
  | 'channelPairAgain'
  | 'channelBrowserHttps';
export interface ConnectionState {
  status: Status;
  root: string;
  pluginRestart?: 'reconnecting' | 'pair-required';
  sessions: SessionSummary[];
  error?: ConnectionError;
  /** Display name the server gives the assistant; Apps show a generic label without it. */
  assistantName?: string;
}
const PIN_KEY = 'swiftnest.channelPins';
export const ROOT_KEY = 'swiftnest.serverRoot';
export function serverRoot(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.pathname.endsWith('/connect') ||
    !url.searchParams.get('token')
  )
    throw new Error('Invalid pairing URL');
  return new URL('./', url).href;
}
function rememberedRoot(): string {
  try {
    const value = localStorage.getItem(ROOT_KEY);
    if (!value) return '';
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      ? url.href
      : '';
  } catch {
    return '';
  }
}
export async function clientOptions(): Promise<ClientOptions> {
  if (isTauriRuntime()) return (await import('./nativeTransport')).nativeOptions();
  return { cookieMode: 'browser' };
}

/** One ephemeral client. Pairing again cancels and disposes the previous attempt. */
export class ConnectionStore {
  readonly chats = new SessionCache();
  client?: SwiftnestClient;
  private generation = 0;
  private expectingRestart = false;
  private restartSources = new Set<object>();
  private unpairing = false;
  private relaySecrets = new Map<string, string>();
  private channelPins = new Map<string, ChannelPairing>();
  private nativeCredentials = new Map<string, string>();
  private retry?: ReturnType<typeof setTimeout>;
  private activeOptions?: ClientOptions;
  private listeners = new Set<() => void>();
  private state: ConnectionState = { status: 'disconnected', root: rememberedRoot(), sessions: [] };
  constructor(
    private options = clientOptions,
    private create = (options: ClientOptions) => new SwiftnestClient(options),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setAssistantName(name: string | undefined) {
    if (name !== this.state.assistantName) this.update({ assistantName: name });
  }
  async pair(url: string): Promise<boolean> {
    const returning = !!this.state.pluginRestart;
    const sessions = this.state.sessions;
    this.disconnect();
    if (returning) this.update({ sessions, pluginRestart: 'pair-required' });
    const generation = this.generation;
    this.update({ status: 'connecting', error: undefined });
    let candidate: SwiftnestClient | undefined;
    try {
      const root = serverRoot(url);
      if (!isTauriRuntime() && typeof location !== 'undefined' && new URL(root).origin !== location.origin) {
        this.update({ status: 'disconnected', error: 'sameOrigin' });
        return false;
      }
      const options = this.withNativeStore(await this.options());
      if (generation !== this.generation) return false;
      const activeOptions = this.socketOptions(this.channelOptions(options), root, generation);
      this.activeOptions = activeOptions;
      candidate = this.create(activeOptions);
      this.client = candidate;
      await candidate.connect(url);
      if (generation !== this.generation) {
        candidate.close();
        return false;
      }
      this.update({ status: 'connected', root, error: undefined, pluginRestart: undefined });
      try {
        localStorage.setItem(ROOT_KEY, root);
      } catch {
        /* Storage can be disabled. */
      }
      await this.refresh();
      return generation === this.generation;
    } catch (error) {
      candidate?.close();
      if (generation === this.generation) {
        this.client = undefined;
        this.update({
          status: 'disconnected',
          error:
            error instanceof ApiError && error.code === 'channel-key-mismatch'
              ? error.text?.key === 'channelBrowserHttps'
                ? 'channelBrowserHttps'
                : 'channelPairAgain'
              : 'pairFailed',
        });
      }
      return false;
    }
  }
  private channelOptions(options: ClientOptions): ClientOptions {
    return {
      ...options,
      relaySecretStore: options.relaySecretStore ?? {
        load: async (root) => this.relaySecrets.get(root),
        save: async (root, secret) => {
          if (secret) this.relaySecrets.set(root, secret);
          else this.relaySecrets.delete(root);
        },
      },
      channelPairingStore: options.channelPairingStore ?? {
        load: async (root) => {
          if (this.channelPins.has(root)) return this.channelPins.get(root);
          try {
            return JSON.parse(localStorage.getItem(PIN_KEY) ?? '{}')[root] as ChannelPairing | undefined;
          } catch {
            return undefined;
          }
        },
        save: async (root, pairing) => {
          this.channelPins.set(root, pairing);
          try {
            const pins = JSON.parse(localStorage.getItem(PIN_KEY) ?? '{}');
            pins[root] = pairing;
            localStorage.setItem(PIN_KEY, JSON.stringify(pins));
          } catch {
            /* Public pins remain available in memory when storage is disabled. */
          }
        },
      },
    };
  }
  private withNativeStore(options: ClientOptions): ClientOptions {
    if (options.cookieMode !== 'manual') return options;
    const generation = this.generation;
    const storage = options.nativePairingStore ?? {
      load: async (root: string) => this.nativeCredentials.get(root),
      save: async (root: string, credential: string | undefined) => {
        if (credential) this.nativeCredentials.set(root, credential);
        else this.nativeCredentials.delete(root);
      },
    };
    return {
      ...options,
      nativePairingStore: {
        load: (root) => storage.load(root),
        save: async (root, credential) => {
          if (generation === this.generation) await storage.save(root, credential);
        },
      },
    };
  }
  /** Opening the native App restores its private saved pairing; transient failures use the same backoff. */
  restore(): void {
    const sameOriginBrowser =
      typeof location !== 'undefined' && new URL(this.state.root || location.origin).origin === location.origin;
    if (
      (!isTauriRuntime() && !sameOriginBrowser) ||
      !this.state.root ||
      this.state.status !== 'disconnected' ||
      this.state.pluginRestart
    )
      return;
    this.startPluginReconnect();
  }
  async unpair(): Promise<void> {
    this.unpairing = true;
    try {
      await this.client?.revokeNativePairing();
      this.disconnect();
    } catch (error) {
      this.startPluginReconnect();
      throw error;
    } finally {
      this.unpairing = false;
    }
  }
  private socketOptions(options: ClientOptions, root: string, generation: number): ClientOptions {
    const factory = options.createWebSocket ?? ((address: string) => new WebSocket(address));
    let rotating = false;
    return {
      ...options,
      onNativeCredentialRotation: (active) => {
        rotating = active;
        options.onNativeCredentialRotation?.(active);
        if (!active && generation === this.generation && this.state.status === 'connected') this.startPluginReconnect();
      },
      createWebSocket: (address, init) => {
        const socket = factory(address, init);
        const lost = () => {
          if (generation !== this.generation || this.state.status !== 'connected' || this.unpairing || rotating) return;
          if (this.expectingRestart || options.cookieMode === 'manual') {
            this.startPluginReconnect();
            return;
          }
          this.disconnect();
          this.update({ error: 'connectionLost' });
        };
        if (
          [new URL('api/remote.mux', root).pathname, '/swiftnest/channel', '/swiftnest/relay'].includes(
            new URL(address).pathname,
          )
        ) {
          socket.addEventListener('close', lost, { once: true });
          socket.addEventListener('error', lost, { once: true });
        }
        return socket;
      },
    };
  }
  expectPluginRestart(expected: boolean, source?: object): void {
    if (source) {
      if (expected) this.restartSources.add(source);
      else this.restartSources.delete(source);
    }
    this.expectingRestart = expected || this.restartSources.size > 0;
  }
  private startPluginReconnect(): void {
    this.chats.clear();
    ++this.generation;
    this.client?.close();
    this.client = undefined;
    this.update({ status: 'connecting', error: undefined, pluginRestart: 'reconnecting' });
    void this.reconnectPlugins(this.generation, 0);
  }
  private async reconnectPlugins(generation: number, attempt: number): Promise<void> {
    let candidate: SwiftnestClient | undefined;
    try {
      const options = this.withNativeStore(await this.options());
      if (generation !== this.generation) return;
      this.activeOptions = this.socketOptions(this.channelOptions(options), this.state.root, generation);
      candidate = this.create(this.activeOptions);
      await candidate.resume(this.state.root);
      if (generation !== this.generation) {
        candidate.close();
        return;
      }
      this.client = candidate;
      this.update({ status: 'connected', pluginRestart: undefined, error: undefined });
      await this.refresh();
    } catch (error) {
      candidate?.close();
      if (generation !== this.generation) return;
      if (
        error instanceof ApiError &&
        (error.code === 'channel-key-mismatch' ||
          (error.code === 'pairing-failed' && [401, 403].includes(error.httpStatus ?? 0)))
      ) {
        this.update({
          status: 'disconnected',
          pluginRestart: 'pair-required',
          error: error.code === 'channel-key-mismatch' ? 'channelPairAgain' : undefined,
        });
        return;
      }
      this.retry = setTimeout(
        () => void this.reconnectPlugins(generation, attempt + 1),
        Math.min(500 * 2 ** attempt, 8000),
      );
    }
  }
  async refresh(): Promise<void> {
    const client = this.client;
    if (!client || this.state.status !== 'connected') return;
    try {
      const sessions = await client.listSessions();
      if (client === this.client)
        this.update({ sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), error: undefined });
    } catch {
      if (client === this.client) this.update({ error: 'loadFailed' });
    }
  }
  /** Match the native identity to this server's assigned namespace, including after pairing/renaming. */
  async updateDeviceContext(devices: Device[]): Promise<void> {
    const client = this.client,
      options = this.activeOptions;
    if (!client || !options || !isTauriRuntime()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const local = await invoke<{ platform: string; fingerprint: string; settings: { slug: string } }>(
        'perch_snapshot',
      );
      if (this.client !== client || this.activeOptions !== options) return;
      const controllable = local.platform === 'desktop' || local.platform === 'android';
      const paired = controllable
        ? devices.find((device) => device.device === local.settings.slug && device.fingerprint === local.fingerprint)
        : undefined;
      if (paired && options.cookieMode === 'manual') await client.bindNativePairing(paired.device, paired.fingerprint);
      options.deviceSlug = paired?.slug;
    } catch {
      if (this.activeOptions === options) options.deviceSlug = undefined;
    }
  }
  async newChat(): Promise<string | undefined> {
    const client = this.client;
    if (!client || this.state.status !== 'connected') return;
    try {
      const { sessionId } = await client.createSession();
      if (client !== this.client) return;
      await this.refresh();
      return client === this.client ? sessionId : undefined;
    } catch {
      if (client === this.client) this.update({ error: 'loadFailed' });
    }
  }
  disconnect(): void {
    this.chats.clear();
    ++this.generation;
    clearTimeout(this.retry);
    this.expectingRestart = false;
    this.restartSources.clear();
    const previous = this.client;
    this.client = undefined;
    this.activeOptions = undefined;
    previous?.close();
    this.update({ status: 'disconnected', sessions: [], error: undefined, pluginRestart: undefined });
  }
}
const Context = createContext<ConnectionStore | null>(null);
export function ConnectionProvider({ children, store: supplied }: PropsWithChildren<{ store?: ConnectionStore }>) {
  const [store] = useState(() => supplied ?? new ConnectionStore());
  const lifetime = useRef(0);
  useEffect(() => {
    const generation = ++lifetime.current;
    store.restore();
    return () => {
      queueMicrotask(() => {
        if (lifetime.current === generation) store.disconnect();
      });
    };
  }, [store]);
  return <Context value={store}>{children}</Context>;
}
export function useConnection() {
  const store = useContext(Context);
  if (!store) throw new Error('ConnectionProvider is required');
  return { store, ...useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) };
}
