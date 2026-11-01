import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiWebSocket, ClientOptions, SwiftnestClient } from '@swiftnest/api';
import { ConnectionStore, ROOT_KEY, clientOptions, serverRoot } from '../src/connection';

afterEach(() => vi.unstubAllGlobals());
function setup(connect = vi.fn(async (_url: string) => {})) {
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  const clients: { connect: typeof connect; close: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn>; createSession: ReturnType<typeof vi.fn> }[] = [];
  const store = new ConnectionStore(async () => ({ cookieMode: 'browser' }), (_options: ClientOptions) => {
    const client = { connect, close: vi.fn(), listSessions: vi.fn(async () => [
      { sessionId: 'old', updatedAt: 1, running: false, blank: false },
      { sessionId: 'new', updatedAt: 2, running: false, blank: false, title: 'Hi' },
    ]), createSession: vi.fn(async () => ({ sessionId: 'created' })) };
    clients.push(client); return client as unknown as SwiftnestClient;
  });
  return { store, clients, storage };
}
const url = 'http://127.0.0.1:3077/connect?token=SECRET&interactions=answer';
describe('connection store', () => {
  it('pairs once, lists real sessions, creates, persists only the root, and closes on reconnect', async () => {
    const { store, clients, storage } = setup();
    const changed = vi.fn(); const unsubscribe = store.subscribe(changed);
    const pairing = store.pair(url);
    expect(store.getSnapshot().status).toBe('connecting');
    expect(await pairing).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ status: 'connected', root: 'http://127.0.0.1:3077/', sessions: [{ sessionId: 'new' }, { sessionId: 'old' }] });
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(ROOT_KEY, 'http://127.0.0.1:3077/');
    expect(JSON.stringify(store.getSnapshot())).not.toContain('SECRET');
    expect(await store.newChat()).toBe('created');
    expect(clients[0]!.createSession).toHaveBeenCalledOnce();
    await store.pair(url);
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    store.disconnect();
    expect(clients[1]!.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(changed).toHaveBeenCalled(); unsubscribe();
  });
  it('does not expose or persist failed pairing URLs/errors', async () => {
    const { store, storage, clients } = setup(vi.fn(async () => { throw new Error(url); }));
    expect(await store.pair(url)).toBe(false);
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ status: 'disconnected', error: 'pairFailed' });
    expect(JSON.stringify(store.getSnapshot())).not.toContain('SECRET');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(await store.newChat()).toBeUndefined();
  });
  it('cancels a stale in-flight pairing without replacing the newer client', async () => {
    let finish!: () => void;
    const { store, clients } = setup(vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => finish = resolve)).mockResolvedValue(undefined));
    const first = store.pair(url);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    expect(await store.pair(url)).toBe(true);
    const current = store.client;
    finish(); expect(await first).toBe(false);
    expect(store.client).toBe(current);
    expect(store.getSnapshot().status).toBe('connected');
    store.disconnect();
  });
  it('rejects cross-origin web pairing and invalid URLs before creating a carrier', async () => {
    const { store, clients } = setup();
    vi.stubGlobal('location', { origin: 'http://different:3077' });
    expect(await store.pair(url)).toBe(false);
    expect(store.getSnapshot().error).toBe('sameOrigin');
    expect(await store.pair('javascript:bad')).toBe(false);
    expect(clients).toHaveLength(0);
    expect(() => serverRoot('http://user:password@host/connect?token=x')).toThrow();
    expect(serverRoot('https://host/mount/connect?token=x')).toBe('https://host/mount/');
  });
  it('keeps ordinary web carrier native-free', async () => {
    expect(await clientOptions()).toEqual({ cookieMode: 'browser' });
  });

  it('reports socket loss even with no open chat and disposes the client', async () => {
    const listeners = new Map<string, () => void>();
    const socket = { addEventListener: vi.fn((type: string, callback: () => void) => listeners.set(type, callback)) } as unknown as ApiWebSocket;
    const close = vi.fn();
    const store = new ConnectionStore(async () => ({ createWebSocket: () => socket }), options => ({
      connect: async () => { options.createWebSocket!('ws://127.0.0.1:3077/api/remote.mux', { headers: {} }); },
      listSessions: async () => [], close,
    }) as unknown as SwiftnestClient);
    expect(await store.pair(url)).toBe(true);
    listeners.get('close')!();
    expect(store.getSnapshot()).toMatchObject({ status: 'disconnected', error: 'connectionLost' });
    expect(store.client).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
