import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiWebSocket, ClientOptions, Device, SwiftnestClient } from '@swiftnest/api';
import { ConnectionStore, ROOT_KEY, clientOptions, serverRoot } from '../src/connection';
import { ApiError, text } from '@swiftnest/api';

afterEach(() => vi.unstubAllGlobals());
function setup(connect = vi.fn(async (_url: string) => {})) {
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  const clients: {
    connect: typeof connect;
    close: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
  }[] = [];
  const store = new ConnectionStore(
    async () => ({ cookieMode: 'browser' }),
    (_options: ClientOptions) => {
      const client = {
        connect,
        close: vi.fn(),
        listSessions: vi.fn(async () => [
          { sessionId: 'old', updatedAt: 1, running: false, blank: false },
          { sessionId: 'new', updatedAt: 2, running: false, blank: false, title: 'Hi' },
        ]),
        createSession: vi.fn(async () => ({ sessionId: 'created' })),
      };
      clients.push(client);
      return client as unknown as SwiftnestClient;
    },
  );
  return { store, clients, storage };
}
const url = 'http://127.0.0.1:3077/connect?token=SECRET&interactions=answer';
describe('connection store', () => {
  it('pairs once, lists real sessions, creates, persists only the root, and closes on reconnect', async () => {
    const { store, clients, storage } = setup();
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);
    const pairing = store.pair(url);
    expect(store.getSnapshot().status).toBe('connecting');
    expect(await pairing).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      status: 'connected',
      root: 'http://127.0.0.1:3077/',
      sessions: [{ sessionId: 'new' }, { sessionId: 'old' }],
    });
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(ROOT_KEY, 'http://127.0.0.1:3077/');
    expect(JSON.stringify(store.getSnapshot())).not.toContain('SECRET');
    expect(await store.newChat()).toBe('created');
    expect(clients[0]!.createSession).toHaveBeenCalledOnce();
    await store.pair(url);
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    store.disconnect();
    expect(clients[1]!.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });
  it('does not expose or persist failed pairing URLs/errors', async () => {
    const { store, storage, clients } = setup(
      vi.fn(async () => {
        throw new Error(url);
      }),
    );
    expect(await store.pair(url)).toBe(false);
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ status: 'disconnected', error: 'pairFailed' });
    expect(JSON.stringify(store.getSnapshot())).not.toContain('SECRET');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(await store.newChat()).toBeUndefined();
  });
  it.each(['channelPairAgain', 'channelBrowserHttps'] as const)('shows the plain %s catalog message', async (key) => {
    const { store } = setup(
      vi.fn(async () => {
        throw new ApiError('channel-key-mismatch', text(key));
      }),
    );
    expect(await store.pair(url)).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ status: 'disconnected', error: key });
    expect(JSON.stringify(store.getSnapshot())).not.toContain('SECRET');
  });
  it('cancels a stale in-flight pairing without replacing the newer client', async () => {
    let finish!: () => void;
    const { store, clients } = setup(
      vi
        .fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
        .mockResolvedValue(undefined),
    );
    const first = store.pair(url);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    expect(await store.pair(url)).toBe(true);
    const current = store.client;
    finish();
    expect(await first).toBe(false);
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

  it('reports only this server’s namespace for the native identity and clears it on revoke or iOS', async () => {
    let active: ClientOptions = {};
    const invoke = vi.fn(async () => ({
      platform: 'desktop',
      fingerprint: 'own-fingerprint',
      settings: { slug: 'own-device' },
    }));
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const store = new ConnectionStore(
      async () => ({}),
      (options) => {
        active = options;
        return { connect: async () => {}, listSessions: async () => [], close: () => {} } as unknown as SwiftnestClient;
      },
    );
    expect(await store.pair(url)).toBe(true);
    const device = { device: 'own-device', fingerprint: 'different', slug: 'server-slug' } as Device;
    await store.updateDeviceContext([device]);
    expect(active.deviceSlug).toBeUndefined();
    device.fingerprint = 'own-fingerprint';
    await store.updateDeviceContext([device]);
    expect(active.deviceSlug).toBe('server-slug');
    await store.updateDeviceContext([]);
    expect(active.deviceSlug).toBeUndefined();
    invoke.mockResolvedValueOnce({
      platform: 'android',
      fingerprint: 'own-fingerprint',
      settings: { slug: 'own-device' },
    });
    await store.updateDeviceContext([device]);
    expect(active.deviceSlug).toBe('server-slug');
    invoke.mockResolvedValueOnce({ platform: 'ios', fingerprint: 'own-fingerprint', settings: { slug: 'own-device' } });
    await store.updateDeviceContext([device]);
    expect(active.deviceSlug).toBeUndefined();
    store.disconnect();
  });

  it('retries browser socket loss even with no open chat instead of requiring pairing again', async () => {
    const listeners = new Map<string, () => void>();
    const socket = {
      addEventListener: vi.fn((type: string, callback: () => void) => listeners.set(type, callback)),
    } as unknown as ApiWebSocket;
    const close = vi.fn();
    const store = new ConnectionStore(
      async () => ({ createWebSocket: () => socket }),
      (options) =>
        ({
          connect: async () => {
            options.createWebSocket!('ws://127.0.0.1:3077/api/remote.mux', { headers: {} });
          },
          resume: async () => {},
          listSessions: async () => [],
          close,
        }) as unknown as SwiftnestClient,
    );
    expect(await store.pair(url)).toBe(true);
    listeners.get('close')!();
    expect(store.getSnapshot()).toMatchObject({ status: 'connecting', error: undefined });
    expect(store.client).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('connected'));
    store.disconnect();
  });

  it('keeps chat connected when a live-view socket closes or fails', async () => {
    const sockets: EventTarget[] = [];
    let active: ClientOptions = {};
    const close = vi.fn();
    const store = new ConnectionStore(
      async () => ({
        createWebSocket: () => {
          const socket = new EventTarget();
          sockets.push(socket);
          return socket as unknown as ApiWebSocket;
        },
      }),
      (options) => {
        active = options;
        return {
          connect: async () => {
            options.createWebSocket!('ws://127.0.0.1:3077/api/remote.mux', { headers: {} });
          },
          listSessions: async () => [],
          close,
        } as unknown as SwiftnestClient;
      },
    );
    expect(await store.pair(url)).toBe(true);
    active.createWebSocket!('ws://127.0.0.1:3077/swiftnest/api/devices/live?id=test', { headers: {} });
    sockets[1]!.dispatchEvent(new Event('error'));
    sockets[1]!.dispatchEvent(new Event('close'));
    expect(store.getSnapshot().status).toBe('connected');
    expect(close).not.toHaveBeenCalled();
    sockets[0]!.dispatchEvent(new Event('close'));
    expect(store.getSnapshot()).toMatchObject({ status: 'connecting', error: undefined });
    expect(close).toHaveBeenCalledOnce();
    store.disconnect();
  });
});

function restartHarness(native = false, reconnect = vi.fn(async () => {})) {
  const sockets: EventTarget[] = [];
  const clients: any[] = [];
  const store = new ConnectionStore(
    async () => ({
      cookieMode: native ? 'manual' : 'browser',
      createWebSocket: () => {
        const socket = new EventTarget();
        sockets.push(socket);
        return socket as unknown as ApiWebSocket;
      },
    }),
    (options) => {
      const open = async () => {
        if (clients.length > 1) await reconnect();
        options.createWebSocket!('ws://127.0.0.1:3077/api/remote.mux', { headers: {} });
      };
      const client = {
        options,
        connect: vi.fn(open),
        resume: vi.fn(open),
        close: vi.fn(),
        listSessions: vi.fn(async () => [{ sessionId: 'saved', title: 'Saved chat', updatedAt: 1 }]),
      };
      clients.push(client);
      return client as unknown as SwiftnestClient;
    },
  );
  return { store, sockets, clients };
}
it('recovers an expected restart with backoff, preserving sessions and using the browser cookie', async () => {
  vi.useFakeTimers();
  const retry = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const { store, sockets, clients } = restartHarness(false, retry);
  try {
    await store.pair(url);
    const sessions = store.getSnapshot().sessions;
    store.expectPluginRestart(true);
    sockets[0]!.dispatchEvent(new Event('close'));
    expect(store.getSnapshot()).toMatchObject({ status: 'connecting', pluginRestart: 'reconnecting', sessions });
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot()).toMatchObject({ status: 'connected', pluginRestart: undefined, sessions });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(clients[2].resume).toHaveBeenCalledWith('http://127.0.0.1:3077/');
    expect(clients[2].connect).not.toHaveBeenCalled();
  } finally {
    store.disconnect();
    vi.useRealTimers();
  }
});
it('keeps a tool restart expected when the plugin resource polls an idle view', async () => {
  const { store, sockets } = restartHarness();
  const tools = {};
  const plugins = {};
  try {
    await store.pair(url);
    store.expectPluginRestart(true, tools);
    store.expectPluginRestart(false, plugins);
    sockets[0]!.dispatchEvent(new Event('close'));
    expect(store.getSnapshot()).toMatchObject({ status: 'connecting', pluginRestart: 'reconnecting' });
  } finally {
    store.disconnect();
  }
});
it('clears a finished resource restart expectation before revoked browser recovery', async () => {
  const { store, sockets } = restartHarness(
    false,
    vi.fn().mockRejectedValueOnce(new ApiError('pairing-failed', 'revoked', undefined, undefined, 403)),
  );
  const tools = {};
  try {
    await store.pair(url);
    store.expectPluginRestart(true, tools);
    store.expectPluginRestart(false, tools);
    sockets[0]!.dispatchEvent(new Event('close'));
    expect(store.getSnapshot().status).toBe('connecting');
    await vi.waitFor(() => expect(store.getSnapshot().pluginRestart).toBe('pair-required'));
    expect(store.getSnapshot().sessions).toEqual([]);
  } finally {
    store.disconnect();
  }
});
it('turns revoked native credential rejection into a single re-pair step, then keeps sessions on successful pairing', async () => {
  const { ApiError } = await import('@swiftnest/api');
  const { store, sockets, clients } = restartHarness(
    true,
    vi.fn().mockRejectedValueOnce(new ApiError('pairing-failed', 'raw token failure', undefined, undefined, 403)),
  );
  await store.pair(url);
  store.expectPluginRestart(true);
  sockets[0]!.dispatchEvent(new Event('close'));
  await vi.waitFor(() => expect(store.getSnapshot().pluginRestart).toBe('pair-required'));
  expect(store.getSnapshot()).toMatchObject({
    status: 'disconnected',
    error: undefined,
    sessions: [{ sessionId: 'saved' }],
  });
  expect(JSON.stringify(store.getSnapshot())).not.toContain('raw');
  expect(clients[1].resume).toHaveBeenCalledWith('http://127.0.0.1:3077/');
  expect(clients[1].connect).not.toHaveBeenCalled();
  expect(await store.pair(url.replace('SECRET', 'NEW'))).toBe(true);
  expect(store.getSnapshot()).toMatchObject({
    status: 'connected',
    pluginRestart: undefined,
    sessions: [{ sessionId: 'saved' }],
  });
  store.disconnect();
});
it('cancels pending restart recovery when the user disconnects', async () => {
  vi.useFakeTimers();
  const retry = vi.fn().mockRejectedValue(new Error('offline'));
  const { store, sockets } = restartHarness(false, retry);
  try {
    await store.pair(url);
    store.expectPluginRestart(true);
    sockets[0]!.dispatchEvent(new Event('close'));
    await vi.advanceTimersByTimeAsync(0);
    store.disconnect();
    await vi.advanceTimersByTimeAsync(10000);
    expect(retry).toHaveBeenCalledOnce();
    expect(store.getSnapshot().status).toBe('disconnected');
  } finally {
    store.disconnect();
    vi.useRealTimers();
  }
});

it('recovers an unannounced native restart without a pairing URL and ignores stale credential writes', async () => {
  const { store, sockets, clients } = restartHarness(true);
  await store.pair(url);
  const original = clients[0].options.nativePairingStore;
  await original.save('http://127.0.0.1:3077/', 'private-credential');
  const sessions = store.getSnapshot().sessions;
  sockets[0]!.dispatchEvent(new Event('close'));
  await vi.waitFor(() => expect(store.getSnapshot().status).toBe('connected'));
  await original.save('http://127.0.0.1:3077/', 'stale-overwrite');
  expect(await clients[1].options.nativePairingStore.load('http://127.0.0.1:3077/')).toBe('private-credential');
  expect(store.getSnapshot().sessions).toEqual(sessions);
  expect(clients[1].resume).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:3077/');
  expect(clients[1].connect).not.toHaveBeenCalled();
  expect(JSON.stringify(store.getSnapshot())).not.toContain('private-credential');
  store.disconnect();
});
it('unpair revokes before forgetting, without reconnecting during the self-revoke socket close', async () => {
  const { store, sockets, clients } = restartHarness(true);
  await store.pair(url);
  clients[0].revokeNativePairing = vi.fn(async () => sockets[0]!.dispatchEvent(new Event('close')));
  await store.unpair();
  expect(clients[0].revokeNativePairing).toHaveBeenCalledOnce();
  expect(clients).toHaveLength(1);
  expect(store.getSnapshot()).toMatchObject({ status: 'disconnected', sessions: [], pluginRestart: undefined });
});
it('restores a reopened native App from its private credential using only the remembered root', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'https://server/', setItem: vi.fn() });
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  const resume = vi.fn(async () => {});
  const connect = vi.fn();
  const store = new ConnectionStore(
    async () => ({ cookieMode: 'manual' }),
    () =>
      ({
        resume,
        connect,
        listSessions: async () => [],
        close: () => {},
      }) as unknown as SwiftnestClient,
  );
  store.restore();
  await vi.waitFor(() => expect(store.getSnapshot().status).toBe('connected'));
  expect(resume).toHaveBeenCalledExactlyOnceWith('https://server/');
  expect(connect).not.toHaveBeenCalled();
  store.disconnect();
});
