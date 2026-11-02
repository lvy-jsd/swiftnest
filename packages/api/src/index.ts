import { LiveView } from './live.js';
export * from './live.js';
import type { Device, DeviceApproval, DeviceAuditEntry, DevicePairing, DevicePairingCandidate, DeviceEvent, DeviceSubscription } from './devices.js';
export type * from './devices.js';
import type { SessionFollowFrame, SessionListValue, SessionCreateValue, SessionPromptValue } from '@deepseek-ai/dsh-api-session-controller/types';
import type { RemoteEventDownlinkFrame } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { mapFrame } from './events.js';
import { ApiError, Inbox, Mux, randomId } from './transport.js';
import type { ApprovalAnswer, ClientOptions, CreateSessionOptions, CreatedSession, Health, MessageReceipt, Question, QuestionAnswer, SessionSummary, Subscription, SwiftnestEvent } from './types.js';
export type * from './types.js';
export { ApiError } from './transport.js';

type Pending = { sessionId: string; kind: 'approval' | 'question'; wait?: Inbox<unknown> };

export class SwiftnestClient {
  private root?: URL;
  private cookie = '';
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
    if (this.state !== 'new') throw new ApiError('invalid-state', 'Create a new client for each pairing');
    const url = new URL(pairingUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.endsWith('/connect') || !url.searchParams.get('token') || url.username || url.password) throw new ApiError('invalid-pairing-url', 'Expected an HTTP(S) /connect URL with a token');
    url.searchParams.set('interactions', 'answer');
    this.root = new URL('./', url);
    this.state = 'connecting';
    try {
      const response = await this.request(url, { redirect: 'manual' });
      // Browser fetch deliberately hides redirect status/headers; its cookie jar
      // still processes Set-Cookie. Socket authentication verifies the exchange.
      if (response.status !== 302 && !(response.type === 'opaqueredirect' && !this.manualCookies)) throw new ApiError('pairing-failed', `Pairing returned HTTP ${response.status}`);
      if (this.manualCookies) {
        const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie()
          : (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/).filter(Boolean);
        this.cookie = cookies.map(value => value.split(';', 1)[0]!.trim()).join('; ');
        if (!this.cookie) throw new ApiError('pairing-failed', 'Pairing did not issue an API cookie');
      }
      const socketUrl = new URL('api/remote.mux', this.root);
      socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      if (this.manualCookies && !this.options.createWebSocket) throw new ApiError('transport-required', 'Node requires createWebSocket with cookie header support (for example ws)');
      const socket = this.options.createWebSocket
        ? this.options.createWebSocket(socketUrl.href, { headers: this.headers() })
        : new WebSocket(socketUrl.href);
      this.connectingSocket = socket;
      this.mux = await Mux.open(socket, this.timeoutMs);
      this.connectingSocket = undefined;
      this.lifetime.signal.throwIfAborted();
      const events = this.mux.stream('$events', {});
      const first = await this.withTimeout(events.next());
      const ready = first.value as RemoteEventDownlinkFrame;
      if (first.done || ready?.type !== 'ready') throw new ApiError('protocol-error', 'Event stream did not begin with ready');
      this.clientId = ready.clientId;
      this.state = 'connected';
      void this.pumpInteractions(events);
    } catch (error) { this.close(); throw error; }
  }

  async health(): Promise<Health> {
    const response = await this.request(this.url('swiftnest/health'));
    if (!response.ok) throw new ApiError('http-error', `Health returned HTTP ${response.status}`);
    return await response.json() as Health;
  }
  listDevices(): Promise<Device[]> { return this.deviceRequest(''); }
  async openLiveView(device: string, options: { maxDimension?: number; displayId?: string; signal?: AbortSignal } = {}): Promise<LiveView> {
    this.assertConnected();
    if(this.root?.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(this.root?.hostname ?? '')) throw new ApiError('tls-required','Use an HTTPS server connection for live view');
    if(!globalThis.crypto?.subtle) throw new ApiError('secure-context-required','Live view requires a secure App context');
    const query=new URLSearchParams({device,maxDimension:String(options.maxDimension ?? 1280),displayId:options.displayId ?? ''});
    const offer=await this.deviceRequest<import('./live.js').LiveOffer>(`/live?${query}`,'POST',options.signal);
    options.signal?.throwIfAborted();
    const url=this.url(`swiftnest/api/devices/live?id=${encodeURIComponent(offer.id)}`);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=this.options.createWebSocket ? this.options.createWebSocket(url.href,{headers:this.headers()}) : new WebSocket(url.href);
    if ('binaryType' in socket) socket.binaryType='arraybuffer';
    const signal=AbortSignal.any([this.lifetime.signal,...(options.signal?[options.signal]:[])]);
    const close=() => socket.close();signal.addEventListener('abort',close,{once:true});
    try {const live=await LiveView.open(socket,offer,this.timeoutMs);void live.closed.then(()=>signal.removeEventListener('abort',close));return live;}
    catch(error){signal.removeEventListener('abort',close);socket.close();throw error;}
  }

  createDevicePairing(): Promise<DevicePairing> { return this.deviceRequest('/pairing', 'POST'); }
  listDevicePairings(): Promise<DevicePairingCandidate[]> { return this.deviceRequest('/pairing'); }
  confirmDevicePairing(id: string, accept: boolean): Promise<{ id: string }> {
    return this.deviceRequest(`/pairing/${encodeURIComponent(id)}/${accept ? 'approve' : 'deny'}`, 'POST');
  }
  revokeDevice(device: string): Promise<{ device: string }> { return this.deviceRequest(`/revoke/${encodeURIComponent(device)}`, 'POST'); }
  listDeviceApprovals(): Promise<DeviceApproval[]> { return this.deviceRequest('/approvals'); }
  answerDeviceApproval(id: string, accept: boolean): Promise<DeviceApproval> {
    return this.deviceRequest(`/approvals/${encodeURIComponent(id)}/${accept ? 'approve' : 'deny'}`, 'POST');
  }
  deviceAudit(limit = 100): Promise<DeviceAuditEntry[]> { return this.deviceRequest(`/audit?limit=${encodeURIComponent(limit)}`); }

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
      const response = await this.doFetch(this.url('swiftnest/api/devices/events'), { credentials: 'include', headers: this.headers(), signal });
      if (!response.ok || !response.body) throw new ApiError('http-error', `Device events returned HTTP ${response.status}`);
      void (async () => {
        const reader = response.body!.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
            if (buffer.length > 65536) throw new ApiError('protocol-error', 'Device event exceeds size limit');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const event = JSON.parse(data) as DeviceEvent;
              if (!['devices-changed', 'approval-pending', 'approvals-changed', 'pairing-changed'].includes(event.type)) throw new ApiError('protocol-error', 'Unknown device event');
              inbox.push(event);
            }
          }
          inbox.end();
        } catch (error) { if (!signal.aborted) inbox.end(error instanceof Error ? error : new Error(String(error))); }
        finally { signal.removeEventListener('abort', cancel); signal.removeEventListener('abort', onAbort); reader.releaseLock(); abort.abort(); }
      })();
      return inbox;
    } catch (error) { signal.removeEventListener('abort', onAbort); abort.abort(); throw error; }
  }
  private async deviceRequest<T>(path: string, method = 'GET', signal?: AbortSignal): Promise<T> {
    this.assertConnected();
    const response = await this.request(this.url(`swiftnest/api/devices${path}`), { method, signal });
    if (!response.ok) throw new ApiError(response.status === 409 ? 'device-conflict' : 'http-error', `Device API returned HTTP ${response.status}`);
    return await response.json() as T;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.rpc<SessionListValue>('session/list', { _request: {} });
    return result.items.map(s => {
      const title = s.projections?.values.title;
      return { sessionId: s.sessionId, updatedAt: s.updatedAt, running: s.running, blank: s.blank,
        ...(s.cwd ? { cwd: s.cwd } : {}), ...(typeof title === 'string' ? { title } : {}) };
    });
  }
  async createSession(options: CreateSessionOptions = {}): Promise<CreatedSession> {
    const result = await this.rpc<SessionCreateValue>('session/create', { request: options });
    return { sessionId: result.sessionId };
  }
  async sendMessage(sessionId: string, text: string): Promise<MessageReceipt> {
    if (!text.trim()) throw new ApiError('invalid-message', 'Message text must not be empty');
    const requestId = randomId();
    this.assertConnected();
    const response = await this.request(this.url('swiftnest/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, deviceSlug: this.options.deviceSlug }) });
    if (!response.ok) {
      const failure = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
      throw new ApiError(failure?.error?.code ?? 'http-error', failure?.error?.message ?? `App prompt returned HTTP ${response.status}`);
    }
    const result = await response.json() as SessionPromptValue;
    return { requestId, accepted: result.accepted };
  }

  /** Resolves only after the initial history snapshot is queued; safe to send immediately afterwards. */
  async follow(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<Subscription> {
    this.assertConnected();
    options.signal?.throwIfAborted();
    const wire = this.mux!.stream('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true } });
    const set = this.subscriptions.get(sessionId) ?? new Set<Inbox<SwiftnestEvent>>();
    this.subscriptions.set(sessionId, set);
    const inbox = new Inbox<SwiftnestEvent>(() => {
      wire.close(); set.delete(inbox);
      if (!set.size) { this.subscriptions.delete(sessionId); this.releaseInteractions(sessionId); }
      options.signal?.removeEventListener('abort', abort);
    });
    const abort = () => inbox.close();
    set.add(inbox);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const first = await this.withTimeout(wire.next());
      if (first.done || (first.value as SessionFollowFrame)?.type !== 'snapshot') throw new ApiError('protocol-error', 'Session follow did not begin with a snapshot');
      for (const event of mapFrame(sessionId, first.value as SessionFollowFrame)) inbox.push(event);
      void (async () => {
        try {
          for await (const frame of wire) for (const event of mapFrame(sessionId, frame as SessionFollowFrame)) inbox.push(event);
        } catch (error) { inbox.push(this.errorEvent(sessionId, error)); }
        finally { inbox.end(); wire.close(); set.delete(inbox); if (!set.size) { this.subscriptions.delete(sessionId); this.releaseInteractions(sessionId); } options.signal?.removeEventListener('abort', abort); }
      })();
      return inbox;
    } catch (error) { inbox.close(); throw error; }
  }

  async answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void> {
    this.getPending(requestId, 'approval');
    await this.answerEvent(requestId, answer);
    this.pending.delete(requestId);
  }
  /** A forwarded request id, or a durable call target for a continued/timed-out question. */
  async answerQuestion(target: string | { sessionId: string; callId: string }, answer: QuestionAnswer): Promise<void> {
    if (typeof target !== 'string') {
      const accepted = await this.rpc<boolean>('userQuestions/answer', { agentId: target.sessionId, callId: target.callId, answer });
      if (!accepted) throw new ApiError('interaction-expired', 'Question no longer accepts an answer');
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
    this.pending.clear(); this.mux?.close(); this.cookie = ''; this.clientId = undefined;
  }
  private async pumpInteractions(stream: Inbox<unknown>): Promise<void> {
    try {
      for await (const item of stream) {
        const frame = item as RemoteEventDownlinkFrame;
        if (frame.type === 'cancel') {
          const pending = this.pending.get(frame.eventId);
          if (pending) { pending.wait?.close(); this.emit({ sessionId: pending.sessionId, type: 'interaction-cancelled', requestId: frame.eventId }); this.pending.delete(frame.eventId); }
        } else if (frame.type === 'waterfall') {
          const sessionId = frame.agentId;
          const kind = frame.event === 'approval/request' ? 'approval' : frame.event === 'user-questions/request' ? 'question' : undefined;
          if (!kind || !this.subscriptions.has(sessionId)) {
            await this.rpc('$events/result', { clientId: this.clientId, eventId: frame.eventId, outcome: { kind: 'next' } });
            continue;
          }
          const pending: Pending = { sessionId, kind };
          this.pending.set(frame.eventId, pending);
          if (kind === 'approval') this.emit({ sessionId, type: 'approval-request', requestId: frame.eventId, toolName: String(frame.request.toolName), reason: frame.request.reason as string | undefined, callId: frame.request.callId as string | undefined });
          else void this.publishQuestion(frame, pending).catch(error => {
            if (this.pending.get(frame.eventId) !== pending) return;
            this.pending.delete(frame.eventId);
            pending.wait?.close();
            this.emit(this.errorEvent(sessionId, error));
            if (this.state === 'connected') void this.rpc('$events/result', { clientId: this.clientId, eventId: frame.eventId, outcome: { kind: 'next' } }).catch(() => {});
          });
        }
      }
      if (this.state === 'connected') throw new ApiError('disconnected', 'Interaction stream ended');
    } catch (error) {
      if (this.state !== 'closed') {
        this.mux?.close(error instanceof Error ? error : new Error(String(error)));
        this.state = 'closed'; this.cookie = ''; this.pending.clear();
      }
    }
  }
  private async publishQuestion(frame: Extract<RemoteEventDownlinkFrame, { type: 'waterfall' }>, pending: Pending): Promise<void> {
    const wait = frame.request.wait as { callId: string; timed?: boolean } | undefined;
    if (wait?.timed) {
      const stream = this.mux!.stream('userQuestions/attachWait', { agentId: pending.sessionId, callId: wait.callId });
      pending.wait = stream;
      // Do not expose an answerable card until the Host confirms this claim.
      const opening = await this.withTimeout(stream.next());
      if (opening.done) throw new ApiError('interaction-expired', 'Question wait already ended');
      if (this.pending.get(frame.eventId) !== pending) return;
      void (async () => {
        try { for await (const _ of stream) { /* countdown is presentation-only */ } }
        catch (error) { if (this.pending.get(frame.eventId) === pending) this.emit(this.errorEvent(pending.sessionId, error)); }
      })();
    }
    if (this.pending.get(frame.eventId) === pending) this.emit({ sessionId: pending.sessionId, type: 'question-request', requestId: frame.eventId, questions: frame.request.questions as Question[], callId: wait?.callId });
  }
  private releaseInteractions(sessionId: string): void {
    for (const [eventId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(eventId);
      pending.wait?.close();
      // With no listener left, resume the Host's answerer chain (fail closed).
      if (this.state === 'connected') void this.rpc('$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'next' } }).catch(() => {});
    }
  }
  private getPending(id: string, kind: Pending['kind']): Pending {
    const pending = this.pending.get(id);
    if (!pending || pending.kind !== kind) throw new ApiError('interaction-expired', 'No matching pending interaction');
    return pending;
  }
  private answerEvent(eventId: string, value: unknown): Promise<unknown> {
    return this.rpc('$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'result', value } });
  }
  private emit(event: SwiftnestEvent): void { for (const inbox of this.subscriptions.get(event.sessionId) ?? []) inbox.push(event); }
  private errorEvent(sessionId: string, error: unknown): SwiftnestEvent {
    return { sessionId, type: 'error', code: error instanceof ApiError ? error.code : 'client-error', message: error instanceof Error ? error.message : String(error) };
  }
  private assertConnected(): void { if (this.state !== 'connected') throw new ApiError('not-connected', 'Connect the client first'); }
  private url(path: string): URL { if (!this.root) throw new ApiError('not-connected', 'Connect the client first'); return new URL(path, this.root); }
  private headers(): Record<string, string> { return this.manualCookies && this.cookie ? { cookie: this.cookie } : {}; }
  private request(url: URL, init: RequestInit = {}): Promise<Response> {
    return this.doFetch(url, { ...init, credentials: 'include', headers: { ...this.headers(), ...init.headers }, signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...(init.signal ? [init.signal] : [])]) });
  }
  private async rpc<T>(endpoint: string, args: unknown): Promise<T> {
    this.assertConnected();
    const rpcId = randomId();
    const response = await this.request(this.url(`api/${endpoint}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }) });
    if (!response.ok) throw new ApiError('http-error', `API returned HTTP ${response.status}`);
    const envelope = await response.json() as { type: string; rpcId: string; result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } };
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') throw new ApiError('protocol-error', 'Invalid or mismatched RPC response');
    if (!envelope.result.ok) throw new ApiError(envelope.result.error.code, envelope.result.error.message);
    return envelope.result.value;
  }
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiError('timeout', 'API stream did not become ready in time')), this.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
}

export async function connect(pairingUrl: string, options: ClientOptions = {}): Promise<SwiftnestClient> {
  const client = new SwiftnestClient(options);
  await client.connect(pairingUrl);
  return client;
}
