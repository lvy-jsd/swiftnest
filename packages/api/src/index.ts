import { AppChannel, pairingChannel, type ChannelPairing } from './channel.js';
export type { ChannelPairing } from './channel.js';
export {
  message,
  localizedReason,
  localizedError,
  language,
  defaultLanguage,
  messageEn,
  messageZh,
  text,
} from '@swiftnest/protocol';
export type { Language, Text } from '@swiftnest/protocol';
import { defaultLanguage, text, isNativePairingCredential, NATIVE_PAIRING_COOKIE } from '@swiftnest/protocol';
import { LiveView } from './live.js';
export * from './live.js';
import type {
  Device,
  DeviceApproval,
  DeviceAuditEntry,
  DevicePairing,
  DevicePairingCandidate,
  DeviceEvent,
  DeviceSubscription,
} from './devices.js';
export type * from './devices.js';
export type * from './memory.js';
import type { PluginsView } from './plugins.js';
export type * from './plugins.js';
import type { ModelSettingsUpdate, ModelsView } from './models.js';
export type * from './models.js';
import type {
  SessionFollowFrame,
  SessionListValue,
  SessionCreateValue,
  SessionPromptValue,
} from '@deepseek-ai/dsh-api-session-controller/types';
import type { RemoteEventDownlinkFrame } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { mapFrame } from './events.js';
import { ApiError, Inbox, Mux, randomId, type ServerFailureBody } from './transport.js';
import type {
  ApprovalAnswer,
  ClientOptions,
  CreateSessionOptions,
  CreatedSession,
  Health,
  ImageInput,
  MessageImage,
  MessageReceipt,
  Question,
  QuestionAnswer,
  SessionSummary,
  Subscription,
  SwiftnestEvent,
  DisplayReason,
} from './types.js';
export type * from './types.js';
export { ApiError } from './transport.js';

type Pending = { sessionId: string; kind: 'approval' | 'question'; wait?: Inbox<unknown> };

export interface Preferences {
  lang: 'zh-CN' | 'en';
  /** Set by the server operator, e.g. "小艾"; absent means Apps show a generic label. */
  assistantName?: string;
}

export class SwiftnestClient {
  private root?: URL;
  private cookie = '';
  private channel?: AppChannel;
  private mux?: Mux;
  private connectingSocket?: import('./types.js').ApiWebSocket;
  private clientId?: string;
  private subscriptions = new Map<string, Set<Inbox<SwiftnestEvent>>>();
  private pending = new Map<string, Pending>();
  private readonly doFetch: typeof fetch;
  private readonly manualCookies: boolean;
  private readonly timeoutMs: number;
  private readonly lifetime = new AbortController();
  private state: 'new' | 'connecting' | 'connected' | 'closed' = 'new';
  constructor(private readonly options: ClientOptions = {}) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.manualCookies = (options.cookieMode ?? (typeof document === 'undefined' ? 'manual' : 'browser')) === 'manual';
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Pair once, exchange the token for a cookie, then establish an answering Peer. */
  async connect(pairingUrl: string): Promise<void> {
    if (this.state !== 'new') throw new ApiError('invalid-state', text('createNewClientEachPairing'));
    const url = new URL(pairingUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.pathname.endsWith('/connect') ||
      !url.searchParams.get('token') ||
      url.username ||
      url.password
    )
      throw new ApiError('invalid-pairing-url', text('expectedHttpSConnectUrlToken'));
    if (!url.searchParams.has('interactions')) url.searchParams.set('interactions', 'answer');
    this.root = new URL('./', url);
    this.state = 'connecting';
    try {
      const pairing = pairingChannel(url);
      if (pairing && !this.localBrowser()) {
        this.requireBrowserTls();
        if (!this.manualCookies) await this.browserSignIn(url);
        await this.connectChannel(pairing, {
          t: 'auth',
          ...(this.manualCookies ? { token: url.searchParams.get('token')! } : { ticket: await this.browserTicket() }),
          interactions: url.searchParams.get('interactions')!,
          browser: !this.manualCookies,
        });
        if (!this.channel?.pairing) await this.options.channelPairingStore?.save(this.root.href, pairing);
        if (this.manualCookies && this.options.nativePairingStore) await this.issueNativePairing();
        await this.openTransport();
        return;
      }
      if (!this.localBrowser() && !this.localRoot() && this.root.protocol !== 'https:')
        throw new ApiError('channel-key-mismatch', text('channelPairAgain'));
      await this.exchangeCookie(url);
      if (this.manualCookies && this.options.nativePairingStore) await this.issueNativePairing();
      await this.openTransport();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Restore the browser cookie or private native credential without a launch token. */
  async resume(root: string): Promise<void> {
    if (this.state !== 'new') throw new ApiError('invalid-state', text('createNewClientEachPairing'));
    this.root = new URL(root);
    this.state = 'connecting';
    try {
      const pairing = await this.options.channelPairingStore?.load(this.root.href);
      if (this.manualCookies) {
        const credential = await this.options.nativePairingStore?.load(this.root.href);
        if (!isNativePairingCredential(credential))
          throw new ApiError('pairing-failed', text('pairingDidNotIssueApiCookie'), undefined, undefined, 401);
        this.cookie = `${NATIVE_PAIRING_COOKIE}=${credential}`;
        if (pairing) await this.connectChannel(pairing, { t: 'auth', cookie: this.cookie });
        else if (!this.localRoot() && this.root.protocol !== 'https:')
          throw new ApiError('channel-key-mismatch', text('channelPairAgain'));
        await this.nativePairingRequest('resume');
      }
      if (!this.manualCookies && pairing && !this.localBrowser()) {
        await this.connectChannel(pairing, { t: 'auth', browser: true, ticket: await this.browserTicket() });
      } else if (!this.manualCookies && !this.localBrowser() && this.root.protocol !== 'https:')
        throw new ApiError('channel-key-mismatch', text('channelPairAgain'));
      await this.openTransport();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async exchangeCookie(url: URL): Promise<void> {
    // API pairings own one ephemeral Peer; browser sessions have a durable owner cookie.
    const exchange = this.manualCookies ? url : new URL('./', url);
    if (!this.manualCookies) exchange.search = url.search;
    const response = await this.request(exchange, { redirect: 'manual' });
    // Browser fetch deliberately hides redirect status/headers; its cookie jar
    // still processes Set-Cookie. Socket authentication verifies the exchange.
    if (response.status !== 302 && !(response.type === 'opaqueredirect' && !this.manualCookies))
      throw new ApiError(
        'pairing-failed',
        text('pairingReturnedHttp', response.status),
        undefined,
        undefined,
        response.status,
      );
    if (this.manualCookies) {
      const cookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/).filter(Boolean);
      this.cookie = cookies.map((value) => value.split(';', 1)[0]!.trim()).join('; ');
      if (!this.cookie) throw new ApiError('pairing-failed', text('pairingDidNotIssueApiCookie'));
    }
  }

  private requireBrowserTls() {
    if (!this.manualCookies && !this.localRoot() && this.root!.protocol !== 'https:')
      throw new ApiError('channel-key-mismatch', text('channelBrowserHttps'));
  }
  private async browserSignIn(pairing: URL) {
    const response = await this.doFetch(new URL('swiftnest/channel/sign-in', this.root!), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: pairing.searchParams.get('token') }),
      credentials: 'same-origin',
      signal: this.lifetime.signal,
    });
    if (!response.ok)
      throw new ApiError('pairing-failed', text('channelPairAgain'), undefined, undefined, response.status);
  }
  private async browserTicket(): Promise<string> {
    if (typeof location === 'undefined' || location.origin !== this.root!.origin)
      throw new ApiError('pairing-failed', text('channelPairAgain'), undefined, undefined, 401);
    const response = await this.doFetch(new URL('swiftnest/channel/bootstrap', this.root!), {
      method: 'POST',
      credentials: 'same-origin',
      signal: this.lifetime.signal,
    });
    if (!response.ok)
      throw new ApiError('pairing-failed', text('channelPairAgain'), undefined, undefined, response.status);
    const value = (await response.json()) as { ticket: string };
    return value.ticket;
  }

  private localRoot(): boolean {
    return ['localhost', '127.0.0.1', '[::1]'].includes(this.root?.hostname ?? '');
  }
  private localBrowser(): boolean {
    return (
      !this.manualCookies &&
      this.localRoot() &&
      typeof location !== 'undefined' &&
      location.origin === this.root?.origin
    );
  }
  private async connectChannel(
    pairing: ChannelPairing,
    auth: import('@swiftnest/channel').ChannelFrame,
  ): Promise<void> {
    this.requireBrowserTls();
    this.channel = await AppChannel.preferred(
      this.root!,
      pairing,
      this.options,
      auth,
      AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]),
    );
    this.cookie = this.channel.cookie;
    if (this.channel.pairing) await this.rememberChannel(this.channel.pairing, this.channel.relaySecret, pairing.key);
  }

  get connectionPath(): 'lan' | 'relay' {
    return this.channel?.viaRelay ? 'relay' : 'lan';
  }
  private async rememberChannel(pairing: ChannelPairing, secret?: string, expectedKey?: string) {
    const old = await this.options.channelPairingStore?.load(this.root!.href);
    // An explicit new pairing link can replace an old pin. Resume and passive
    // metadata updates still have to match the key that authenticated this channel.
    const key = expectedKey ?? old?.key;
    if (key && key !== pairing.key) throw new ApiError('channel-key-mismatch', text('channelPairAgain'));
    await this.options.channelPairingStore?.save(this.root!.href, pairing);
    await this.options.relaySecretStore?.save(this.root!.href, secret);
  }
  getRelay(): Promise<{ address: string; connected: boolean }> {
    return this.relayRequest('GET');
  }
  async setRelay(config: { address: string; secret: string } | null): Promise<{ address: string; connected: boolean }> {
    const result = await this.relayRequest('POST', config);
    const response = await this.request(new URL('swiftnest/relay/connection', this.root!), {});
    if (response.ok) {
      const metadata = (await response.json()) as { pairing: ChannelPairing; relaySecret?: string };
      await this.rememberChannel(metadata.pairing, metadata.relaySecret);
    }
    return result;
  }
  private async relayRequest(
    method: string,
    config?: { address: string; secret: string } | null,
  ): Promise<{ address: string; connected: boolean }> {
    this.assertConnected();
    const response = await this.request(new URL('swiftnest/relay', this.root!), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(config) } : {}),
    });
    if (!response.ok)
      throw ApiError.fromServer(
        'relay-settings',
        await response.json().catch(() => undefined),
        text('relayInvalidSettings'),
        response.status,
      );
    return response.json();
  }

  private async issueNativePairing(): Promise<void> {
    const { credential } = await this.nativePairingRequest<{ credential: string }>(
      'issue',
      this.options.nativeDevice ?? {},
    );
    await this.saveNativeCredential(credential);
  }

  /** Explicit rotation preserves scope and expiry and invalidates the old credential. */
  async rotateNativePairing(): Promise<void> {
    this.assertConnected();
    if (!this.manualCookies || !this.options.nativePairingStore)
      throw new ApiError('invalid-state', text('createNewClientEachPairing'));
    this.options.onNativeCredentialRotation?.(true);
    try {
      const { credential } = await this.nativePairingRequest<{ credential: string }>('rotate');
      await this.saveNativeCredential(credential);
    } finally {
      this.options.onNativeCredentialRotation?.(false);
    }
  }

  private async saveNativeCredential(credential: string): Promise<void> {
    if (!isNativePairingCredential(credential))
      throw new ApiError('pairing-failed', text('pairingDidNotIssueApiCookie'));
    await this.options.nativePairingStore!.save(this.root!.href, credential);
    this.cookie = `${NATIVE_PAIRING_COOKIE}=${credential}`;
  }

  async bindNativePairing(device: string, fingerprint: string): Promise<void> {
    if (this.manualCookies && this.options.nativePairingStore)
      await this.nativePairingRequest('bind', { device, fingerprint });
  }

  async revokeNativePairing(): Promise<void> {
    if (!this.manualCookies || !this.options.nativePairingStore) return;
    await this.nativePairingRequest('revoke');
    await this.options.nativePairingStore.save(this.root!.href, undefined);
  }

  private async nativePairingRequest<T = unknown>(action: string, body = {}): Promise<T> {
    const response = await this.request(this.url(`swiftnest/native/${action}`), {
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) await this.options.nativePairingStore?.save(this.root!.href, undefined);
      throw new ApiError(
        'pairing-failed',
        text('pairingReturnedHttp', response.status),
        undefined,
        undefined,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  private async openTransport(): Promise<void> {
    const socketUrl = new URL('api/remote.mux', this.root!);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.manualCookies && !this.options.createWebSocket)
      throw new ApiError('transport-required', text('nodeRequiresCreatewebsocketCookieHeaderSupport'));
    const socket = this.channel
      ? this.channel.socket(socketUrl.pathname, this.cookie)
      : this.options.createWebSocket
        ? this.options.createWebSocket(socketUrl.href, { headers: this.headers() })
        : new WebSocket(socketUrl.href);
    this.connectingSocket = socket;
    this.mux = await Mux.open(socket, this.timeoutMs);
    this.connectingSocket = undefined;
    this.lifetime.signal.throwIfAborted();
    const events = this.mux.stream('$events', {});
    const first = await this.withTimeout(events.next());
    const ready = first.value as RemoteEventDownlinkFrame;
    if (first.done || ready?.type !== 'ready')
      throw new ApiError('protocol-error', text('eventStreamDidNotBeginReady'));
    this.clientId = ready.clientId;
    this.state = 'connected';
    void this.pumpInteractions(events);
  }

  async health(): Promise<Health> {
    const response = await this.request(this.url('swiftnest/health'));
    if (!response.ok) throw new ApiError('http-error', text('healthReturnedHttp', response.status));
    return (await response.json()) as Health;
  }
  /** The owner's language and the assistant's display name (when the server sets one). */
  getPreferences(): Promise<Preferences> {
    return this.deviceRequest('/preferences');
  }
  setLanguage(lang: 'zh-CN' | 'en'): Promise<Preferences> {
    return this.deviceRequest('/preferences', 'POST', undefined, { lang });
  }
  listTransfers(): Promise<import('./devices.js').Transfer[]> {
    return this.deviceRequest('/transfers');
  }
  startTransfer(request: import('./devices.js').TransferRequest): Promise<import('./devices.js').Transfer> {
    return this.deviceRequest('/transfers', 'POST', undefined, request);
  }
  transferAction(
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry',
  ): Promise<import('./devices.js').Transfer> {
    return this.deviceRequest(`/transfers/${encodeURIComponent(id)}/${action}`, 'POST');
  }
  /** Audited plugins with their switches, community market installs, and the last apply. */
  listPlugins(): Promise<PluginsView> {
    return this.ownerRequest('plugins');
  }
  /** Save a switch; it takes effect at the next `applyPlugins`. */
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginsView> {
    return this.ownerRequest(`plugins/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, 'POST');
  }
  /**
   * Install what the switches need and restart the server's agent. The answer comes before the
   * restart; the connection then drops briefly. Follow `apply.state` with `listPlugins`.
   */
  applyPlugins(): Promise<PluginsView> {
    return this.ownerRequest('plugins/apply', 'POST');
  }
  listModels(): Promise<ModelsView> {
    return this.ownerRequest('models');
  }
  /** Save which models do what; it takes effect at the next `applyModels`, except `freeVision`, which takes effect at once. */
  updateModels(update: ModelSettingsUpdate): Promise<ModelsView> {
    return this.ownerRequest('models/settings', 'POST', undefined, update);
  }
  /** Save a provider's API key; the server never sends it back. An empty key removes it. */
  setModelKey(provider: string, key: string): Promise<ModelsView> {
    return this.ownerRequest(`models/keys/${encodeURIComponent(provider)}`, 'POST', undefined, { key });
  }
  /** Restart the server's agent with the saved models; follow `apply.state` with `listModels`. */
  applyModels(): Promise<ModelsView> {
    return this.ownerRequest('models/apply', 'POST');
  }
  listDevices(): Promise<Device[]> {
    return this.deviceRequest('');
  }
  async openLiveView(
    device: string,
    options: { maxDimension?: number; displayId?: string; signal?: AbortSignal } = {},
  ): Promise<LiveView> {
    this.assertConnected();
    if (this.root?.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.root?.hostname ?? ''))
      throw new ApiError('tls-required', text('useHttpsServerConnectionLiveView'));
    if (!globalThis.crypto?.subtle)
      throw new ApiError('secure-context-required', text('liveViewRequiresSecureAppContext'));
    const query = new URLSearchParams({
      device,
      maxDimension: String(options.maxDimension ?? 1280),
      displayId: options.displayId ?? '',
    });
    const offer = await this.deviceRequest<import('./live.js').LiveOffer>(`/live?${query}`, 'POST', options.signal);
    options.signal?.throwIfAborted();
    const url = this.url(`swiftnest/api/devices/live?id=${encodeURIComponent(offer.id)}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.channel
      ? this.channel.socket(`${url.pathname}${url.search}`, this.cookie)
      : this.options.createWebSocket
        ? this.options.createWebSocket(url.href, { headers: this.headers() })
        : new WebSocket(url.href);
    if ('binaryType' in socket) socket.binaryType = 'arraybuffer';
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const close = () => socket.close();
    signal.addEventListener('abort', close, { once: true });
    try {
      const live = await LiveView.open(socket, offer, this.timeoutMs);
      void live.closed.then(() => signal.removeEventListener('abort', close));
      return live;
    } catch (error) {
      signal.removeEventListener('abort', close);
      socket.close();
      throw error;
    }
  }

  createDevicePairing(): Promise<DevicePairing> {
    return this.deviceRequest('/pairing', 'POST');
  }
  listDevicePairings(): Promise<DevicePairingCandidate[]> {
    return this.deviceRequest('/pairing');
  }
  confirmDevicePairing(id: string, accept: boolean): Promise<{ id: string }> {
    return this.deviceRequest(`/pairing/${encodeURIComponent(id)}/${accept ? 'approve' : 'deny'}`, 'POST');
  }
  revokeDevice(device: string): Promise<{ device: string }> {
    return this.deviceRequest(`/revoke/${encodeURIComponent(device)}`, 'POST');
  }
  listDeviceApprovals(): Promise<DeviceApproval[]> {
    return this.deviceRequest('/approvals');
  }
  answerDeviceApproval(id: string, accept: boolean): Promise<DeviceApproval> {
    return this.deviceRequest(`/approvals/${encodeURIComponent(id)}/${accept ? 'approve' : 'deny'}`, 'POST');
  }
  deviceAudit(limit = 100): Promise<DeviceAuditEntry[]> {
    return this.deviceRequest(`/audit?limit=${encodeURIComponent(limit)}`);
  }

  /** Fetch-based SSE works with browser cookies and the native/manual-cookie carrier. */
  async watchDevices(options: { signal?: AbortSignal } = {}): Promise<DeviceSubscription> {
    this.assertConnected();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const inbox = new Inbox<DeviceEvent>(() => abort.abort());
    const onAbort = () => inbox.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await this.streamRequest(this.url('swiftnest/api/devices/events'), {
        credentials: 'include',
        headers: this.headers(),
        signal,
      });
      if (!response.ok || !response.body)
        throw new ApiError('http-error', text('deviceEventsReturnedHttp', response.status));
      void (async () => {
        const reader = response.body!.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
            if (buffer.length > 65536) throw new ApiError('protocol-error', text('deviceEventExceedsSizeLimit'));
            for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (!data) continue;
              const event = JSON.parse(data) as DeviceEvent;
              if (
                ![
                  'devices-changed',
                  'approval-pending',
                  'approvals-changed',
                  'pairing-changed',
                  'transfers-changed',
                  'plugins-changed',
                  'models-changed',
                  'memory-changed',
                ].includes(event.type)
              )
                throw new ApiError('protocol-error', text('unknownDeviceEvent'));
              inbox.push(event);
            }
          }
          inbox.end();
        } catch (error) {
          if (!signal.aborted) inbox.end(error instanceof Error ? error : new Error(String(error)));
        } finally {
          signal.removeEventListener('abort', cancel);
          signal.removeEventListener('abort', onAbort);
          reader.releaseLock();
          abort.abort();
        }
      })();
      return inbox;
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      abort.abort();
      throw error;
    }
  }
  memoryAutoSettings(): Promise<{ enabled: boolean }> {
    return this.memoryRequest('/auto');
  }
  setMemoryAuto(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.memoryRequest('/auto', { enabled });
  }
  recentAutoMemory(): Promise<import('./memory.js').MemoryEntry[]> {
    return this.memoryRequest('/auto/recent');
  }
  listMemory(): Promise<import('./memory.js').MemoryView> {
    return this.memoryRequest('');
  }
  addMemory(value: string, topic?: string): Promise<{ saved: boolean; entry: import('./memory.js').MemoryEntry }> {
    return this.memoryRequest('/add', { text: value, topic });
  }
  editMemory(id: string, value: string): Promise<import('./memory.js').MemoryView> {
    return this.memoryRequest('/edit', { id, text: value });
  }
  deleteMemory(id: string): Promise<import('./memory.js').MemoryView> {
    return this.memoryRequest('/delete', { id });
  }
  readMemoryTopic(topic: string): Promise<import('./memory.js').MemoryTopic> {
    return this.memoryRequest(`/topic?${new URLSearchParams({ topic })}`);
  }
  writeMemoryTopic(topic: string, content: string): Promise<import('./memory.js').MemoryTopic> {
    return this.memoryRequest('/topic', { topic, content });
  }
  private async memoryRequest<T>(path: string, body?: unknown): Promise<T> {
    this.assertConnected();
    const response = await this.request(this.url(`swiftnest/api/memory${path}`), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'accept-language': defaultLanguage(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as ServerFailureBody | undefined;
      throw ApiError.fromServer('http-error', failure, text('memoryApiReturnedHttp', response.status));
    }
    return (await response.json()) as T;
  }
  private deviceRequest<T>(path: string, method = 'GET', signal?: AbortSignal, body?: unknown): Promise<T> {
    return this.ownerRequest(`devices${path}`, method, signal, body);
  }
  /** The owner-only server API under `/swiftnest/api/`. */
  private async ownerRequest<T>(path: string, method = 'GET', signal?: AbortSignal, body?: unknown): Promise<T> {
    this.assertConnected();
    const response = await this.request(this.url(`swiftnest/api/${path}`), {
      method,
      signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as ServerFailureBody | undefined;
      const code = response.status === 409 ? 'device-conflict' : 'http-error';
      throw ApiError.fromServer(code, failure, text('deviceApiReturnedHttp', response.status), response.status);
    }
    return (await response.json()) as T;
  }

  /** The bytes of an image stored with a message, as a `data:` URL the App can show. */
  async readImage(sessionId: string, image: MessageImage): Promise<string> {
    const value = await this.rpc<{ attachment: { mediaType: string }; data: string }>('session/attachment', {
      request: { sessionId, attachmentId: image.attachmentId },
    });
    return `data:${value.attachment.mediaType};base64,${value.data}`;
  }
  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.rpc<SessionListValue>('session/list', { _request: {} });
    return result.items.map((s) => {
      const title = s.projections?.values.title;
      return {
        sessionId: s.sessionId,
        updatedAt: s.updatedAt,
        running: s.running,
        blank: s.blank,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(typeof title === 'string' ? { title } : {}),
      };
    });
  }
  async createSession(options: CreateSessionOptions = {}): Promise<CreatedSession> {
    const result = await this.rpc<SessionCreateValue>('session/create', { request: options });
    return { sessionId: result.sessionId };
  }
  /** Send a message, optionally with images; a message needs text or at least one image. */
  async sendMessage(sessionId: string, message: string, images: readonly ImageInput[] = []): Promise<MessageReceipt> {
    if (!message.trim() && !images.length) throw new ApiError('invalid-message', text('messageTextMustNotEmpty'));
    const requestId = randomId();
    this.assertConnected();
    const content = [
      ...images.map((image) => ({ type: 'image', ...image })),
      ...(message.trim() ? [{ type: 'text', text: message }] : []),
    ];
    const response = await this.request(this.url('swiftnest/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: { sessionId, requestId, mode: 'queue', content },
        deviceSlug: this.options.deviceSlug,
      }),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as { error?: ServerFailureBody } | undefined;
      const code = failure?.error?.code ?? 'http-error';
      throw ApiError.fromServer(code, failure?.error, text('appPromptReturnedHttp', response.status));
    }
    const result = (await response.json()) as SessionPromptValue;
    return { requestId, accepted: result.accepted };
  }

  /** Resolves only after the initial history snapshot is queued; safe to send immediately afterwards. */
  async follow(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<Subscription> {
    this.assertConnected();
    options.signal?.throwIfAborted();
    const wire = this.mux!.stream('session/follow', {
      request: { address: { kind: 'session', sessionId }, assistantStream: true },
    });
    const set = this.subscriptions.get(sessionId) ?? new Set<Inbox<SwiftnestEvent>>();
    this.subscriptions.set(sessionId, set);
    const inbox = new Inbox<SwiftnestEvent>(() => {
      wire.close();
      set.delete(inbox);
      if (!set.size) {
        this.subscriptions.delete(sessionId);
        this.releaseInteractions(sessionId);
      }
      options.signal?.removeEventListener('abort', abort);
    });
    const abort = () => inbox.close();
    set.add(inbox);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const first = await this.withTimeout(wire.next());
      if (first.done || (first.value as SessionFollowFrame)?.type !== 'snapshot')
        throw new ApiError('protocol-error', text('sessionFollowDidNotBeginSnapshot'));
      for (const event of mapFrame(sessionId, first.value as SessionFollowFrame)) inbox.push(event);
      void (async () => {
        try {
          for await (const frame of wire)
            for (const event of mapFrame(sessionId, frame as SessionFollowFrame)) inbox.push(event);
        } catch (error) {
          inbox.push(this.errorEvent(sessionId, error));
        } finally {
          inbox.end();
          wire.close();
          set.delete(inbox);
          if (!set.size) {
            this.subscriptions.delete(sessionId);
            this.releaseInteractions(sessionId);
          }
          options.signal?.removeEventListener('abort', abort);
        }
      })();
      return inbox;
    } catch (error) {
      inbox.close();
      throw error;
    }
  }

  async answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void> {
    this.getPending(requestId, 'approval');
    await this.answerEvent(requestId, answer);
    this.pending.delete(requestId);
  }
  /** A forwarded request id, or a durable call target for a continued/timed-out question. */
  async answerQuestion(target: string | { sessionId: string; callId: string }, answer: QuestionAnswer): Promise<void> {
    if (typeof target !== 'string') {
      const accepted = await this.rpc<boolean>('userQuestions/answer', {
        agentId: target.sessionId,
        callId: target.callId,
        answer,
      });
      if (!accepted) throw new ApiError('interaction-expired', text('questionNoLongerAcceptsAnswer'));
      return;
    }
    const pending = this.getPending(target, 'question');
    await this.answerEvent(target, answer);
    pending.wait?.close();
    this.pending.delete(target);
  }

  close(): void {
    this.state = 'closed';
    this.lifetime.abort();
    this.connectingSocket?.close();
    this.connectingSocket = undefined;
    for (const set of this.subscriptions.values()) for (const inbox of set) inbox.close();
    this.subscriptions.clear();
    for (const pending of this.pending.values()) pending.wait?.close();
    this.pending.clear();
    this.mux?.close();
    this.channel?.close();
    this.cookie = '';
    this.clientId = undefined;
  }
  private async pumpInteractions(stream: Inbox<unknown>): Promise<void> {
    try {
      for await (const item of stream) {
        const frame = item as RemoteEventDownlinkFrame;
        if (frame.type === 'cancel') {
          const pending = this.pending.get(frame.eventId);
          if (pending) {
            pending.wait?.close();
            this.emit({ sessionId: pending.sessionId, type: 'interaction-cancelled', requestId: frame.eventId });
            this.pending.delete(frame.eventId);
          }
        } else if (frame.type === 'waterfall') {
          const sessionId = frame.agentId;
          const kind =
            frame.event === 'approval/request'
              ? 'approval'
              : frame.event === 'user-questions/request'
                ? 'question'
                : undefined;
          if (!kind || !this.subscriptions.has(sessionId)) {
            await this.rpc('$events/result', {
              clientId: this.clientId,
              eventId: frame.eventId,
              outcome: { kind: 'next' },
            });
            continue;
          }
          const pending: Pending = { sessionId, kind };
          this.pending.set(frame.eventId, pending);
          if (kind === 'approval')
            this.emit({
              sessionId,
              type: 'approval-request',
              requestId: frame.eventId,
              toolName: String(frame.request.toolName),
              reason: frame.request.reason as string | undefined,
              displayReason: displayReasonOf(frame.request.displayReason),
              callId: frame.request.callId as string | undefined,
            });
          else
            void this.publishQuestion(frame, pending).catch((error) => {
              if (this.pending.get(frame.eventId) !== pending) return;
              this.pending.delete(frame.eventId);
              pending.wait?.close();
              this.emit(this.errorEvent(sessionId, error));
              if (this.state === 'connected')
                void this.rpc('$events/result', {
                  clientId: this.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'next' },
                }).catch(() => {});
            });
        }
      }
      if (this.state === 'connected') throw new ApiError('disconnected', text('interactionStreamEnded'));
    } catch (error) {
      if (this.state !== 'closed') {
        this.mux?.close(error instanceof Error ? error : new Error(String(error)));
        this.state = 'closed';
        this.cookie = '';
        this.pending.clear();
      }
    }
  }
  private async publishQuestion(
    frame: Extract<RemoteEventDownlinkFrame, { type: 'waterfall' }>,
    pending: Pending,
  ): Promise<void> {
    const wait = frame.request.wait as { callId: string; timed?: boolean } | undefined;
    if (wait?.timed) {
      const stream = this.mux!.stream('userQuestions/attachWait', { agentId: pending.sessionId, callId: wait.callId });
      pending.wait = stream;
      // Do not expose an answerable card until the Host confirms this claim.
      const opening = await this.withTimeout(stream.next());
      if (opening.done) throw new ApiError('interaction-expired', text('questionWaitAlreadyEnded'));
      if (this.pending.get(frame.eventId) !== pending) return;
      void (async () => {
        try {
          for await (const _ of stream) {
            /* countdown is presentation-only */
          }
        } catch (error) {
          if (this.pending.get(frame.eventId) === pending) this.emit(this.errorEvent(pending.sessionId, error));
        }
      })();
    }
    if (this.pending.get(frame.eventId) === pending)
      this.emit({
        sessionId: pending.sessionId,
        type: 'question-request',
        requestId: frame.eventId,
        questions: frame.request.questions as Question[],
        callId: wait?.callId,
      });
  }
  private releaseInteractions(sessionId: string): void {
    for (const [eventId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(eventId);
      pending.wait?.close();
      // With no listener left, resume the Host's answerer chain (fail closed).
      if (this.state === 'connected')
        void this.rpc('$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'next' } }).catch(
          () => {},
        );
    }
  }
  private getPending(id: string, kind: Pending['kind']): Pending {
    const pending = this.pending.get(id);
    if (!pending || pending.kind !== kind)
      throw new ApiError('interaction-expired', text('noMatchingPendingInteraction'));
    return pending;
  }
  private answerEvent(eventId: string, value: unknown): Promise<unknown> {
    return this.rpc('$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'result', value } });
  }
  private emit(event: SwiftnestEvent): void {
    for (const inbox of this.subscriptions.get(event.sessionId) ?? []) inbox.push(event);
  }
  private errorEvent(sessionId: string, error: unknown): SwiftnestEvent {
    return {
      sessionId,
      type: 'error',
      code: error instanceof ApiError ? error.code : 'client-error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  private assertConnected(): void {
    if (this.state !== 'connected') throw new ApiError('not-connected', text('connectClientFirst'));
  }
  private url(path: string): URL {
    if (!this.root) throw new ApiError('not-connected', text('connectClientFirst'));
    return new URL(path, this.root);
  }
  private headers(): Record<string, string> {
    return this.manualCookies && this.cookie ? { cookie: this.cookie } : {};
  }
  private request(url: URL, init: RequestInit = {}): Promise<Response> {
    return this.streamRequest(url, {
      ...init,
      credentials: 'include',
      headers: { ...this.headers(), ...init.headers },
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(this.timeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  }
  private streamRequest(url: URL, init: RequestInit): Promise<Response> {
    return this.channel ? this.channel.fetch(url, init, this.cookie) : this.doFetch(url, init);
  }
  private async rpc<T>(endpoint: string, args: unknown): Promise<T> {
    this.assertConnected();
    const rpcId = randomId();
    const response = await this.request(this.url(`api/${endpoint}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    if (!response.ok) throw new ApiError('http-error', text('apiReturnedHttp', response.status));
    const envelope = (await response.json()) as {
      type: string;
      rpcId: string;
      result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
    };
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean')
      throw new ApiError('protocol-error', text('invalidMismatchedRpcResponse'));
    if (!envelope.result.ok) throw new ApiError(envelope.result.error.code, envelope.result.error.message);
    return envelope.result.value;
  }
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ApiError('timeout', text('apiStreamDidNotBecomeReady'))), this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function connect(pairingUrl: string, options: ClientOptions = {}): Promise<SwiftnestClient> {
  const client = new SwiftnestClient(options);
  await client.connect(pairingUrl);
  return client;
}

/** The request's per-language reason, when it has the shape DSH defines ({ en, ...locales }). */
function displayReasonOf(value: unknown): DisplayReason | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  const copy = Object.fromEntries(entries);
  return typeof copy.en === 'string' ? (copy as DisplayReason) : undefined;
}
