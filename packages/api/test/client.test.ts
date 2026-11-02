import { describe, expect, it, vi } from 'vitest';
import { connect, SwiftnestClient, ApiError, type ApiWebSocket, type SocketEventMap } from '@swiftnest/api';

class Socket implements ApiWebSocket {
  readyState = 0;
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: any[] = [];
  constructor() { queueMicrotask(() => { this.readyState = 1; this.fire('open', {}); }); }
  addEventListener(type: string, fn: (e: any) => void): void { const set = this.listeners.get(type) ?? new Set(); set.add(fn); this.listeners.set(type, set); }
  removeEventListener(type: string, fn: (e: any) => void): void { this.listeners.get(type)?.delete(fn); }
  fire<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]): void { for (const fn of [...this.listeners.get(type) ?? []]) fn(event); }
  frame(streamId: string, value: unknown): void { this.fire('message', { data: JSON.stringify({ type: 'item', streamId, value }) }); }
  send(data: string): void {
    const frame = JSON.parse(data); this.sent.push(frame);
    if (frame.type !== 'open') return;
    queueMicrotask(() => {
      if (frame.endpoint === '$events') this.frame(frame.streamId, { type: 'ready', clientId: 'peer-1', host: { home: '/home/test' } });
      if (frame.endpoint === 'session/follow') this.frame(frame.streamId, { type: 'snapshot', records: [], cursor: -1 });
      if (frame.endpoint === 'userQuestions/attachWait') this.frame(frame.streamId, { remainingMs: 1000 });
    });
  }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.fire('close', {}); }
  interaction(value: unknown): void { this.frame(this.sent.find(f => f.endpoint === '$events').streamId, value); }
}

function harness(options: { badRpcId?: boolean; failRpc?: boolean; browser?: boolean; legacyHeaders?: boolean; devices?: (url: string, init: RequestInit) => Response } = {}) {
  let socket!: Socket;
  const calls: { url: string; init: RequestInit; body?: any }[] = [];
  const doFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    if (url.includes('/connect?')) {
      if (options.browser) return { status: 0, type: 'opaqueredirect' } as Response;
      const response = new Response(null, { status: 302, headers: { 'set-cookie': options.legacyHeaders
        ? 'dsh_api=secret; Expires=Wed, 01 Jan 2030 00:00:00 GMT; HttpOnly, second=value; Path=/api'
        : 'dsh_api=secret; HttpOnly; Path=/api', location: './api/remote.mux' } });
      if (options.legacyHeaders) Object.defineProperty(response.headers, 'getSetCookie', { value: undefined });
      return response;
    }
    if (url.includes('/swiftnest/api/devices')) return options.devices?.(url, init) ?? Response.json([]);
    const value = body?.method === 'session/create' ? { sessionId: 'session-1' }
      : body?.method === 'session/list' ? { items: [{ sessionId: 'session-1', updatedAt: 100, running: false, blank: true, projections: { values: { title: 'Test' } } }] }
      : { accepted: true };
    return Response.json({ type: 'server-response', rpcId: options.badRpcId ? 'wrong' : body.rpcId,
      result: options.failRpc ? { ok: false, error: { code: 'session/agent-busy', message: 'Busy' } } : { ok: true, value } });
  });
  const factory = vi.fn((_url: string, _options: { headers: Readonly<Record<string, string>> }) => socket = new Socket());
  const client = new SwiftnestClient({ fetch: doFetch, createWebSocket: factory, cookieMode: options.browser ? 'browser' : 'manual', timeoutMs: 500 });
  return { client, calls, factory, get socket() { return socket; } };
}
const pairing = 'https://server.test/mount/connect?token=launch&interactions=answer';

describe('independent API client', () => {
  it('exchanges cookies, retains the mount, and correlates native RPCs without page globals', async () => {
    const h = harness();
    await h.client.connect(pairing);
    try {
      expect(h.calls[0]?.init).toMatchObject({ redirect: 'manual', credentials: 'include' });
      expect(h.factory).toHaveBeenCalledWith('wss://server.test/mount/api/remote.mux', { headers: { cookie: 'dsh_api=secret' } });
      expect(await h.client.createSession()).toEqual({ sessionId: 'session-1' });
      expect(await h.client.listSessions()).toEqual([{ sessionId: 'session-1', updatedAt: 100, running: false, blank: true, title: 'Test' }]);
      expect(h.calls[1]).toMatchObject({ url: 'https://server.test/mount/api/session/create', init: { headers: { cookie: 'dsh_api=secret' } }, body: { type: 'client-request', method: 'session/create', payload: { args: { request: {} } } } });
      const receipt = await h.client.sendMessage('session-1', 'hi');
      expect(h.calls.at(-1)?.body.payload.args.request.requestId).toBe(receipt.requestId);
      await expect(h.client.sendMessage('session-1', '  ')).rejects.toMatchObject({ code: 'invalid-message' });
    } finally { h.client.close(); }
  });
  it('accepts browser opaque redirects and leaves cookies to the jar', async () => {
    const h = harness({ browser: true }); await h.client.connect(pairing);
    try { await h.client.createSession(); expect(h.factory.mock.calls[0]?.[1].headers).toEqual({}); expect(h.calls[1]?.init.headers).not.toHaveProperty('cookie'); }
    finally { h.client.close(); }
  });
  it('reads native cookies on WebViews without Headers.getSetCookie, preserving Expires commas', async () => {
    const h = harness({ legacyHeaders: true });
    await h.client.connect(pairing);
    try { expect(h.factory.mock.calls[0]?.[1].headers).toEqual({ cookie: 'dsh_api=secret; second=value' }); }
    finally { h.client.close(); }
  });
  it.each([{ badRpcId: true, code: 'protocol-error' }, { failRpc: true, code: 'session/agent-busy' }])('preserves remote errors and rejects mismatched replies: $code', async opts => {
    const h = harness(opts); await h.client.connect(pairing);
    try { await expect(h.client.createSession()).rejects.toMatchObject({ code: opts.code }); }
    finally { h.client.close(); }
  });
  it('cancels one stream on return/abort, waking a blocked reader without closing siblings', async () => {
    const h = harness(); await h.client.connect(pairing);
    try {
      const abort = new AbortController();
      const a = await h.client.follow('a', { signal: abort.signal }); const b = await h.client.follow('b');
      const read = a.next(); abort.abort(); expect(await read).toMatchObject({ done: true });
      const bRead = b.next(); await b.return!(); expect(await bRead).toMatchObject({ done: true });
      expect(h.socket.sent.filter(f => f.type === 'cancel')).toHaveLength(2);
      expect(h.socket.readyState).toBe(1);
    } finally { h.client.close(); }
  });
  it('ends subscriptions with typed errors when a physical socket is lost', async () => {
    const h = harness(); await h.client.connect(pairing); const sub = await h.client.follow('a');
    h.socket.close();
    expect((await sub.next()).value).toMatchObject({ type: 'error', code: 'disconnected' });
    expect(await sub.next()).toMatchObject({ done: true });
    await expect(h.client.sendMessage('a', 'hi')).rejects.toBeInstanceOf(ApiError);
    h.client.close();
  });
  it('forwards approvals/questions, correlates answers, and rejects cancelled requests', async () => {
    const h = harness(); await h.client.connect(pairing); const sub = await h.client.follow('a');
    try {
      h.socket.interaction({ type: 'waterfall', event: 'approval/request', agentId: 'a', eventId: 'approval-1', request: { toolName: 'shell', reason: 'Run command' } });
      expect((await sub.next()).value).toMatchObject({ type: 'approval-request', requestId: 'approval-1', toolName: 'shell' });
      await h.client.answerApproval('approval-1', 'rejected');
      expect(h.calls.at(-1)?.body).toMatchObject({ method: '$events/result', payload: { args: { clientId: 'peer-1', eventId: 'approval-1', outcome: { kind: 'result', value: 'rejected' } } } });
      h.socket.interaction({ type: 'waterfall', event: 'user-questions/request', agentId: 'a', eventId: 'question-1', request: { questions: [{ id: 'q', question: 'Pick?' }] } });
      expect((await sub.next()).value).toMatchObject({ type: 'question-request' });
      const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
      await h.client.answerQuestion('question-1', answer);
      expect(h.calls.at(-1)?.body.payload.args.outcome.value).toEqual(answer);
      h.socket.interaction({ type: 'waterfall', event: 'approval/request', agentId: 'a', eventId: 'approval-2', request: { toolName: 'shell' } });
      await sub.next(); h.socket.interaction({ type: 'cancel', eventId: 'approval-2' });
      expect((await sub.next()).value).toMatchObject({ type: 'interaction-cancelled', requestId: 'approval-2' });
      await expect(h.client.answerApproval('approval-2', 'allowed-once')).rejects.toMatchObject({ code: 'interaction-expired' });
    } finally { h.client.close(); }
  });
  it('claims timed questions before publishing, releases the claim on answer and supports late replies', async () => {
    const h = harness(); await h.client.connect(pairing); const sub = await h.client.follow('a');
    try {
      h.socket.interaction({ type: 'waterfall', event: 'user-questions/request', agentId: 'a', eventId: 'timed-1', request: { questions: [{ id: 'q', question: 'Pick?' }], wait: { callId: 'call-1', timed: true } } });
      expect((await sub.next()).value).toMatchObject({ type: 'question-request', requestId: 'timed-1', callId: 'call-1' });
      const claim = h.socket.sent.find(f => f.endpoint === 'userQuestions/attachWait');
      expect(claim.payload.args).toEqual({ agentId: 'a', callId: 'call-1' });
      const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
      await h.client.answerQuestion('timed-1', answer);
      expect(h.socket.sent).toContainEqual({ type: 'cancel', streamId: claim.streamId });
      expect(h.calls.at(-1)?.body.method).toBe('$events/result');
      await h.client.answerQuestion({ sessionId: 'a', callId: 'call-2' }, answer);
      expect(h.calls.at(-1)?.body).toMatchObject({ method: 'userQuestions/answer', payload: { args: { agentId: 'a', callId: 'call-2', answer } } });
    } finally { h.client.close(); }
  });
  it('delegates unfollowed and withdrawn interactions to the next Host answerer', async () => {
    const h = harness(); await h.client.connect(pairing); const sub = await h.client.follow('a');
    try {
      h.socket.interaction({ type: 'waterfall', event: 'approval/request', agentId: 'a', eventId: 'withdrawn', request: { toolName: 'shell' } });
      await sub.next(); sub.close();
      await vi.waitFor(() => expect(h.calls.at(-1)?.body.payload.args).toMatchObject({ eventId: 'withdrawn', outcome: { kind: 'next' } }));
      h.socket.interaction({ type: 'waterfall', event: 'approval/request', agentId: 'other', eventId: 'unfollowed', request: { toolName: 'shell' } });
      await vi.waitFor(() => expect(h.calls.at(-1)?.body.payload.args).toMatchObject({ eventId: 'unfollowed', outcome: { kind: 'next' } }));
    } finally { h.client.close(); }
  });
  it('fails pairing without a cookie and cleans up a socket that never becomes ready', async () => {
    await expect(connect(pairing, { fetch: async () => new Response(null, { status: 302 }) })).rejects.toMatchObject({ code: 'pairing-failed' });
    const h = harness();
    h.factory.mockImplementation(() => { const s = new Socket(); s.send = () => {}; return s; });
    await expect(h.client.connect(pairing)).rejects.toMatchObject({ code: 'timeout' });
    expect(h.factory.mock.results[0]?.value.readyState).toBe(3);
  });
});


describe('device API client', () => {
  it('uses session cookies, preserves mounts, encodes identifiers and sends explicit decisions', async () => {
    const h = harness({ devices: () => Response.json({ ok: true }) });
    await h.client.connect(pairing);
    try {
      await h.client.listDevices(); await h.client.createDevicePairing(); await h.client.listDevicePairings();
      await h.client.confirmDevicePairing('p/1', false); await h.client.revokeDevice('my device');
      await h.client.listDeviceApprovals(); await h.client.answerDeviceApproval('task/1', true); await h.client.answerDeviceApproval('task/2', false); await h.client.deviceAudit(10);
      expect(h.calls.slice(1).map(c => [c.url.replace('https://server.test/mount/swiftnest/api/devices', ''), c.init.method])).toEqual([
        ['', 'GET'], ['/pairing', 'POST'], ['/pairing', 'GET'], ['/pairing/p%2F1/deny', 'POST'], ['/revoke/my%20device', 'POST'],
        ['/approvals', 'GET'], ['/approvals/task%2F1/approve', 'POST'], ['/approvals/task%2F2/deny', 'POST'], ['/audit?limit=10', 'GET'],
      ]);
      for (const call of h.calls.slice(1)) expect(call.init).toMatchObject({ credentials: 'include', headers: { cookie: 'dsh_api=secret' } });
    } finally { h.client.close(); }
  });
  it('keeps browser cookies in the jar and reports stale decisions as conflicts', async () => {
    const h = harness({ browser: true, devices: () => new Response('{}', { status: 409 }) });
    await h.client.connect(pairing);
    try {
      await expect(h.client.answerDeviceApproval('expired', true)).rejects.toMatchObject({ code: 'device-conflict' });
      expect(h.calls.at(-1)?.init.headers).not.toHaveProperty('cookie');
    } finally { h.client.close(); }
  });
  it('parses split SSE frames and cancels a pending reader on abort or client close', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const h = harness({ devices: () => new Response(new ReadableStream({ start(c) { output = c; }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) });
    await h.client.connect(pairing);
    const abort = new AbortController();
    try {
      const stream = await h.client.watchDevices({ signal: abort.signal });
      const enc = new TextEncoder();
      output.enqueue(enc.encode(': heartbeat\r\n\r\ndata: {"type":"approval-'));
      output.enqueue(enc.encode('pending"}\r\n\r\n'));
      expect((await stream.next()).value).toEqual({ type: 'approval-pending' });
      const next = stream.next(); abort.abort();
      expect(await next).toMatchObject({ done: true });
      await expect.poll(() => cancelled).toBe(true);
      const second = await h.client.watchDevices(); const pending = second.next();
      h.client.close(); expect(await pending).toMatchObject({ done: true });
    } finally { h.client.close(); }
  });
  it('does not expose device API calls before session authentication', async () => {
    const client = new SwiftnestClient();
    await expect(client.listDevices()).rejects.toMatchObject({ code: 'not-connected' });
    await expect(client.watchDevices()).rejects.toMatchObject({ code: 'not-connected' });
    client.close();
  });
});
