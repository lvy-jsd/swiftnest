import { describe, expect, it, vi } from 'vitest';
import {
  connect,
  SwiftnestClient,
  ApiError,
  type ApiWebSocket,
  type SocketEventMap,
  type ClientOptions,
} from '@swiftnest/api';

class Socket implements ApiWebSocket {
  readyState = 0;
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: any[] = [];
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire('open', {});
    });
  }
  addEventListener(type: string, fn: (e: any) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  frame(streamId: string, value: unknown): void {
    this.fire('message', { data: JSON.stringify({ type: 'item', streamId, value }) });
  }
  send(data: string): void {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (frame.type !== 'open') return;
    queueMicrotask(() => {
      if (frame.endpoint === '$events')
        this.frame(frame.streamId, { type: 'ready', clientId: 'peer-1', host: { home: '/home/test' } });
      if (frame.endpoint === 'session/follow')
        this.frame(frame.streamId, { type: 'snapshot', records: [], cursor: -1 });
      if (frame.endpoint === 'userQuestions/attachWait') this.frame(frame.streamId, { remainingMs: 1000 });
    });
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', {});
  }
  interaction(value: unknown): void {
    this.frame(this.sent.find((f) => f.endpoint === '$events').streamId, value);
  }
}

function harness(
  options: {
    badRpcId?: boolean;
    failRpc?: boolean;
    browser?: boolean;
    legacyHeaders?: boolean;
    deviceSlug?: string;
    memory?: (url: string, init: RequestInit) => Response;
    search?: (url: string, init: RequestInit) => Response;
    devices?: (url: string, init: RequestInit) => Response;
    nativePairingStore?: ClientOptions['nativePairingStore'];
    native?: (url: string, init: RequestInit) => Response;
  } = {},
) {
  let socket!: Socket;
  const calls: { url: string; init: RequestInit; body?: any }[] = [];
  const doFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    if (new URL(url).searchParams.has('token')) {
      if (options.browser) return { status: 0, type: 'opaqueredirect' } as Response;
      const response = new Response(null, {
        status: 302,
        headers: {
          'set-cookie': options.legacyHeaders
            ? 'dsh_api=secret; Expires=Wed, 01 Jan 2030 00:00:00 GMT; HttpOnly, second=value; Path=/api'
            : 'dsh_api=secret; HttpOnly; Path=/api',
          location: './api/remote.mux',
        },
      });
      if (options.legacyHeaders) Object.defineProperty(response.headers, 'getSetCookie', { value: undefined });
      return response;
    }
    if (url.includes('/swiftnest/native/'))
      return options.native?.(url, init) ?? Response.json({ credential: 'N'.repeat(43) });
    if (url.endsWith('/swiftnest/api/chat')) return Response.json({ accepted: true });
    if (url.includes('/swiftnest/api/search')) return options.search?.(url, init) ?? Response.json([]);
    if (url.includes('/swiftnest/api/memory'))
      return options.memory?.(url, init) ?? Response.json({ entries: [], topics: [] });
    if (url.includes('/swiftnest/api/devices')) return options.devices?.(url, init) ?? Response.json([]);
    if (url.includes('/swiftnest/api/plugins')) return Response.json({ plugins: [] });
    const value =
      body?.method === 'session/create'
        ? { sessionId: 'session-1' }
        : body?.method === 'session/list'
          ? {
              items: [
                {
                  sessionId: 'session-1',
                  updatedAt: 100,
                  running: false,
                  blank: true,
                  projections: { values: { title: 'Test' } },
                },
              ],
            }
          : { accepted: true };
    return Response.json({
      type: 'server-response',
      rpcId: options.badRpcId ? 'wrong' : body.rpcId,
      result: options.failRpc
        ? { ok: false, error: { code: 'session/agent-busy', message: 'Busy' } }
        : { ok: true, value },
    });
  });
  const factory = vi.fn(
    (_url: string, _options: { headers: Readonly<Record<string, string>> }) => (socket = new Socket()),
  );
  const client = new SwiftnestClient({
    fetch: doFetch,
    nativePairingStore: options.nativePairingStore,
    createWebSocket: factory,
    deviceSlug: options.deviceSlug,
    cookieMode: options.browser ? 'browser' : 'manual',
    timeoutMs: 500,
  });
  return {
    client,
    calls,
    factory,
    get socket() {
      return socket;
    },
  };
}
const pairing = 'https://server.test/mount/connect?token=launch&interactions=answer';

describe('independent API client', () => {
  it('exchanges web links for the durable browser cookie instead of a single-socket API Peer', async () => {
    const h = harness({ browser: true });
    await h.client.connect(pairing);
    expect(h.calls[0]?.url).toBe('https://server.test/mount/?token=launch&interactions=answer');
    expect(h.calls[0]?.init).toMatchObject({ redirect: 'manual', credentials: 'include' });
    expect(h.factory).toHaveBeenCalledWith('wss://server.test/mount/api/remote.mux', { headers: {} });
    await h.client.listPlugins();
    expect(h.calls.at(-1)?.init.credentials).toBe('include');
    h.client.close();
  });
  it('exchanges cookies, retains the mount, and correlates native RPCs without page globals', async () => {
    const h = harness();
    await h.client.connect(pairing);
    try {
      expect(h.calls[0]?.init).toMatchObject({ redirect: 'manual', credentials: 'include' });
      expect(h.factory).toHaveBeenCalledWith('wss://server.test/mount/api/remote.mux', {
        headers: { cookie: 'dsh_api=secret' },
      });
      expect(await h.client.createSession()).toEqual({ sessionId: 'session-1' });
      expect(await h.client.listSessions()).toEqual([
        { sessionId: 'session-1', updatedAt: 100, running: false, blank: true, title: 'Test' },
      ]);
      expect(h.calls[1]).toMatchObject({
        url: 'https://server.test/mount/api/session/create',
        init: { headers: { cookie: 'dsh_api=secret' } },
        body: { type: 'client-request', method: 'session/create', payload: { args: { request: {} } } },
      });
      const receipt = await h.client.sendMessage('session-1', 'hi');
      expect(h.calls.at(-1)?.body.request.requestId).toBe(receipt.requestId);
      expect(h.calls.at(-1)).toMatchObject({
        url: 'https://server.test/mount/swiftnest/api/chat',
        body: { request: { sessionId: 'session-1', mode: 'queue' } },
      });
      expect(h.calls.at(-1)?.body).not.toHaveProperty('deviceSlug');
      await expect(h.client.sendMessage('session-1', '  ')).rejects.toMatchObject({ code: 'invalid-message' });
    } finally {
      h.client.close();
    }
  });
  it('accepts browser opaque redirects and leaves cookies to the jar', async () => {
    const h = harness({ browser: true });
    await h.client.connect(pairing);
    try {
      await h.client.createSession();
      expect(h.factory.mock.calls[0]?.[1].headers).toEqual({});
      expect(h.calls[1]?.init.headers).not.toHaveProperty('cookie');
    } finally {
      h.client.close();
    }
  });
  it('reads native cookies on WebViews without Headers.getSetCookie, preserving Expires commas', async () => {
    const h = harness({ legacyHeaders: true });
    await h.client.connect(pairing);
    try {
      expect(h.factory.mock.calls[0]?.[1].headers).toEqual({ cookie: 'dsh_api=secret; second=value' });
    } finally {
      h.client.close();
    }
  });
  it.each([
    { badRpcId: true, code: 'protocol-error' },
    { failRpc: true, code: 'session/agent-busy' },
  ])('preserves remote errors and rejects mismatched replies: $code', async (opts) => {
    const h = harness(opts);
    await h.client.connect(pairing);
    try {
      await expect(h.client.createSession()).rejects.toMatchObject({ code: opts.code });
    } finally {
      h.client.close();
    }
  });
  it('cancels one stream on return/abort, waking a blocked reader without closing siblings', async () => {
    const h = harness();
    await h.client.connect(pairing);
    try {
      const abort = new AbortController();
      const a = await h.client.follow('a', { signal: abort.signal });
      const b = await h.client.follow('b');
      const read = a.next();
      abort.abort();
      expect(await read).toMatchObject({ done: true });
      const bRead = b.next();
      await b.return!();
      expect(await bRead).toMatchObject({ done: true });
      expect(h.socket.sent.filter((f) => f.type === 'cancel')).toHaveLength(2);
      expect(h.socket.readyState).toBe(1);
    } finally {
      h.client.close();
    }
  });
  it('ends subscriptions with typed errors when a physical socket is lost', async () => {
    const h = harness();
    await h.client.connect(pairing);
    const sub = await h.client.follow('a');
    h.socket.close();
    expect((await sub.next()).value).toMatchObject({ type: 'error', code: 'disconnected' });
    expect(await sub.next()).toMatchObject({ done: true });
    await expect(h.client.sendMessage('a', 'hi')).rejects.toBeInstanceOf(ApiError);
    h.client.close();
  });
  it('forwards approvals/questions, correlates answers, and rejects cancelled requests', async () => {
    const h = harness();
    await h.client.connect(pairing);
    const sub = await h.client.follow('a');
    try {
      h.socket.interaction({
        type: 'waterfall',
        event: 'approval/request',
        agentId: 'a',
        eventId: 'approval-1',
        request: { toolName: 'shell', reason: 'Run command' },
      });
      expect((await sub.next()).value).toMatchObject({
        type: 'approval-request',
        requestId: 'approval-1',
        toolName: 'shell',
      });
      await h.client.answerApproval('approval-1', 'rejected');
      expect(h.calls.at(-1)?.body).toMatchObject({
        method: '$events/result',
        payload: {
          args: { clientId: 'peer-1', eventId: 'approval-1', outcome: { kind: 'result', value: 'rejected' } },
        },
      });
      h.socket.interaction({
        type: 'waterfall',
        event: 'user-questions/request',
        agentId: 'a',
        eventId: 'question-1',
        request: { questions: [{ id: 'q', question: 'Pick?' }] },
      });
      expect((await sub.next()).value).toMatchObject({ type: 'question-request' });
      const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
      await h.client.answerQuestion('question-1', answer);
      expect(h.calls.at(-1)?.body.payload.args.outcome.value).toEqual(answer);
      h.socket.interaction({
        type: 'waterfall',
        event: 'approval/request',
        agentId: 'a',
        eventId: 'approval-2',
        request: { toolName: 'shell' },
      });
      await sub.next();
      h.socket.interaction({ type: 'cancel', eventId: 'approval-2' });
      expect((await sub.next()).value).toMatchObject({ type: 'interaction-cancelled', requestId: 'approval-2' });
      await expect(h.client.answerApproval('approval-2', 'allowed-once')).rejects.toMatchObject({
        code: 'interaction-expired',
      });
    } finally {
      h.client.close();
    }
  });
  it('claims timed questions before publishing, releases the claim on answer and supports late replies', async () => {
    const h = harness();
    await h.client.connect(pairing);
    const sub = await h.client.follow('a');
    try {
      h.socket.interaction({
        type: 'waterfall',
        event: 'user-questions/request',
        agentId: 'a',
        eventId: 'timed-1',
        request: { questions: [{ id: 'q', question: 'Pick?' }], wait: { callId: 'call-1', timed: true } },
      });
      expect((await sub.next()).value).toMatchObject({
        type: 'question-request',
        requestId: 'timed-1',
        callId: 'call-1',
      });
      const claim = h.socket.sent.find((f) => f.endpoint === 'userQuestions/attachWait');
      expect(claim.payload.args).toEqual({ agentId: 'a', callId: 'call-1' });
      const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
      await h.client.answerQuestion('timed-1', answer);
      expect(h.socket.sent).toContainEqual({ type: 'cancel', streamId: claim.streamId });
      expect(h.calls.at(-1)?.body.method).toBe('$events/result');
      await h.client.answerQuestion({ sessionId: 'a', callId: 'call-2' }, answer);
      expect(h.calls.at(-1)?.body).toMatchObject({
        method: 'userQuestions/answer',
        payload: { args: { agentId: 'a', callId: 'call-2', answer } },
      });
    } finally {
      h.client.close();
    }
  });
  it('delegates unfollowed and withdrawn interactions to the next Host answerer', async () => {
    const h = harness();
    await h.client.connect(pairing);
    const sub = await h.client.follow('a');
    try {
      h.socket.interaction({
        type: 'waterfall',
        event: 'approval/request',
        agentId: 'a',
        eventId: 'withdrawn',
        request: { toolName: 'shell' },
      });
      await sub.next();
      sub.close();
      await vi.waitFor(() =>
        expect(h.calls.at(-1)?.body.payload.args).toMatchObject({ eventId: 'withdrawn', outcome: { kind: 'next' } }),
      );
      h.socket.interaction({
        type: 'waterfall',
        event: 'approval/request',
        agentId: 'other',
        eventId: 'unfollowed',
        request: { toolName: 'shell' },
      });
      await vi.waitFor(() =>
        expect(h.calls.at(-1)?.body.payload.args).toMatchObject({ eventId: 'unfollowed', outcome: { kind: 'next' } }),
      );
    } finally {
      h.client.close();
    }
  });
  it('fails pairing without a cookie and cleans up a socket that never becomes ready', async () => {
    await expect(connect(pairing, { fetch: async () => new Response(null, { status: 302 }) })).rejects.toMatchObject({
      code: 'pairing-failed',
    });
    const h = harness();
    h.factory.mockImplementation(() => {
      const s = new Socket();
      s.send = () => {};
      return s;
    });
    await expect(h.client.connect(pairing)).rejects.toMatchObject({ code: 'timeout' });
    expect(h.factory.mock.results[0]?.value.readyState).toBe(3);
  });
});

describe('device API client', () => {
  it('uses session cookies, preserves mounts, encodes identifiers and sends explicit decisions', async () => {
    const h = harness({ devices: () => Response.json({ ok: true }) });
    await h.client.connect(pairing);
    try {
      await h.client.listDevices();
      await h.client.createDevicePairing();
      await h.client.listDevicePairings();
      await h.client.confirmDevicePairing('p/1', false);
      await h.client.revokeDevice('my device');
      await h.client.listDeviceApprovals();
      await h.client.answerDeviceApproval('task/1', true);
      await h.client.answerDeviceApproval('task/2', false);
      await h.client.deviceAudit(10);
      expect(
        h.calls
          .slice(1)
          .map((c) => [c.url.replace('https://server.test/mount/swiftnest/api/devices', ''), c.init.method]),
      ).toEqual([
        ['', 'GET'],
        ['/pairing', 'POST'],
        ['/pairing', 'GET'],
        ['/pairing/p%2F1/deny', 'POST'],
        ['/revoke/my%20device', 'POST'],
        ['/approvals', 'GET'],
        ['/approvals/task%2F1/approve', 'POST'],
        ['/approvals/task%2F2/deny', 'POST'],
        ['/audit?limit=10', 'GET'],
      ]);
      for (const call of h.calls.slice(1))
        expect(call.init).toMatchObject({ credentials: 'include', headers: { cookie: 'dsh_api=secret' } });
    } finally {
      h.client.close();
    }
  });
  it('drives the plugin page API with the session cookie', async () => {
    const h = harness();
    await h.client.connect(pairing);
    try {
      await h.client.listPlugins();
      await h.client.setPluginEnabled('vision-router', true);
      await h.client.setPluginEnabled('market', false);
      await h.client.applyPlugins();
      expect(h.calls.slice(1).map((c) => [c.url.replace('https://server.test/mount/', ''), c.init.method])).toEqual([
        ['swiftnest/api/plugins', 'GET'],
        ['swiftnest/api/plugins/vision-router/enable', 'POST'],
        ['swiftnest/api/plugins/market/disable', 'POST'],
        ['swiftnest/api/plugins/apply', 'POST'],
      ]);
      for (const call of h.calls.slice(1)) expect(call.init).toMatchObject({ headers: { cookie: 'dsh_api=secret' } });
    } finally {
      h.client.close();
    }
  });
  it('keeps browser cookies in the jar and reports stale decisions as conflicts', async () => {
    const h = harness({ browser: true, devices: () => new Response('{}', { status: 409 }) });
    await h.client.connect(pairing);
    try {
      await expect(h.client.answerDeviceApproval('expired', true)).rejects.toMatchObject({ code: 'device-conflict' });
      expect(h.calls.at(-1)?.init.headers).not.toHaveProperty('cookie');
    } finally {
      h.client.close();
    }
  });
  it('parses split SSE frames and cancels a pending reader on abort or client close', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const h = harness({
      devices: () =>
        new Response(
          new ReadableStream({
            start(c) {
              output = c;
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    await h.client.connect(pairing);
    const abort = new AbortController();
    try {
      const stream = await h.client.watchDevices({ signal: abort.signal });
      const enc = new TextEncoder();
      output.enqueue(enc.encode(': heartbeat\r\n\r\ndata: {"type":"approval-'));
      output.enqueue(enc.encode('pending"}\r\n\r\n'));
      expect((await stream.next()).value).toEqual({ type: 'approval-pending' });
      output.enqueue(enc.encode('data: {"type":"plugins-changed"}\n\n'));
      expect((await stream.next()).value).toEqual({ type: 'plugins-changed' });
      output.enqueue(enc.encode('data: {"type":"memory-changed"}\n\n'));
      expect((await stream.next()).value).toEqual({ type: 'memory-changed' });
      const next = stream.next();
      abort.abort();
      expect(await next).toMatchObject({ done: true });
      await expect.poll(() => cancelled).toBe(true);
      const second = await h.client.watchDevices();
      const pending = second.next();
      h.client.close();
      expect(await pending).toMatchObject({ done: true });
    } finally {
      h.client.close();
    }
  });
  it('does not expose device API calls before session authentication', async () => {
    const client = new SwiftnestClient();
    await expect(client.listDevices()).rejects.toMatchObject({ code: 'not-connected' });
    await expect(client.watchDevices()).rejects.toMatchObject({ code: 'not-connected' });
    client.close();
  });
});

it('reports the paired native App connection on the prompt that sends the chat', async () => {
  const h = harness({ deviceSlug: 'phone' });
  await h.client.connect(pairing);
  try {
    await h.client.sendMessage('session-1', 'hi');
    expect(h.calls.at(-1)?.body).toMatchObject({ deviceSlug: 'phone', request: { sessionId: 'session-1' } });
  } finally {
    h.client.close();
  }
});

it('resumes browser sessions without exchanging the old launch token and rejects native resume without a saved credential', async () => {
  const h = harness({ browser: true });
  await h.client.resume('https://server.test/mount/');
  expect(h.calls).toEqual([]);
  expect(h.factory).toHaveBeenCalledWith('wss://server.test/mount/api/remote.mux', { headers: {} });
  await h.client.listPlugins();
  h.client.close();
  const native = harness();
  await expect(native.client.resume('https://server.test/')).rejects.toMatchObject({
    code: 'pairing-failed',
    httpStatus: 401,
  });
  expect(native.factory).not.toHaveBeenCalled();
});

it('uses authenticated central memory endpoints and preserves catalog errors', async () => {
  const { client, calls } = harness({
    memory: (_url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.text === 'rejected')
        return Response.json({ code: 'MEMORY_SECRET', text: { key: 'memorySecret' } }, { status: 400 });
      return Response.json({ entries: [], topics: [] });
    },
  });
  await client.connect(pairing);
  try {
    await client.listPlugins();
    await client.listMemory();
    await client.addMemory('fact', 'Work');
    await client.editMemory('id-one', 'updated');
    await client.deleteMemory('id-one');
    await client.readMemoryTopic('中文 space');
    await client.writeMemoryTopic('Work', '- next');
    const memory = calls.filter((call) => call.url.includes('/swiftnest/api/memory'));
    expect(memory.map((call) => new URL(call.url).pathname)).toEqual([
      '/mount/swiftnest/api/memory',
      '/mount/swiftnest/api/memory/add',
      '/mount/swiftnest/api/memory/edit',
      '/mount/swiftnest/api/memory/delete',
      '/mount/swiftnest/api/memory/topic',
      '/mount/swiftnest/api/memory/topic',
    ]);
    expect(new URL(memory[4]!.url).searchParams.get('topic')).toBe('中文 space');
    expect(memory.every((call) => (call.init.headers as Record<string, string>).cookie === 'dsh_api=secret')).toBe(
      true,
    );
    expect(memory[1]!.body).toEqual({ text: 'fact', topic: 'Work' });
    await expect(client.addMemory('rejected')).rejects.toMatchObject({
      text: { key: 'memorySecret' },
      serverCode: 'MEMORY_SECRET',
    });
  } finally {
    client.close();
  }
});

it('persists native credentials privately and resumes using only the scoped Cookie, without another launch exchange', async () => {
  let saved: string | undefined;
  const storage = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (_root: string, credential: string | undefined) => {
      saved = credential;
    }),
  };
  const paired = harness({ nativePairingStore: storage });
  await paired.client.connect(pairing.replace('answer', 'none'));
  expect(new URL(paired.calls[0]!.url).searchParams.get('interactions')).toBe('none');
  expect(paired.calls[1]).toMatchObject({
    url: 'https://server.test/mount/swiftnest/native/issue',
    init: { headers: { cookie: 'dsh_api=secret' } },
  });
  expect(storage.save).toHaveBeenCalledWith('https://server.test/mount/', 'N'.repeat(43));
  paired.client.close();
  const resumed = harness({ nativePairingStore: storage });
  await resumed.client.resume('https://server.test/mount/');
  expect(resumed.calls.map((r) => r.url)).toEqual(['https://server.test/mount/swiftnest/native/resume']);
  expect(resumed.factory).toHaveBeenCalledWith('wss://server.test/mount/api/remote.mux', {
    headers: { cookie: `swiftnest_native=${'N'.repeat(43)}` },
  });
  await resumed.client.bindNativePairing('phone', 'fingerprint');
  expect(resumed.calls.at(-1)?.body).toEqual({ device: 'phone', fingerprint: 'fingerprint' });
  await resumed.client.rotateNativePairing();
  await resumed.client.revokeNativePairing();
  expect(saved).toBeUndefined();
  resumed.client.close();
});
it('preserves a native credential on temporary server failure, and forgets it only on authentication rejection', async () => {
  const store = { load: async () => 'N'.repeat(43), save: vi.fn(async () => {}) };
  const offline = harness({ nativePairingStore: store, native: () => new Response(null, { status: 503 }) });
  await expect(offline.client.resume('https://server.test/')).rejects.toMatchObject({ httpStatus: 503 });
  expect(store.save).not.toHaveBeenCalled();
  const revoked = harness({ nativePairingStore: store, native: () => new Response(null, { status: 401 }) });
  await expect(revoked.client.resume('https://server.test/')).rejects.toMatchObject({
    code: 'pairing-failed',
    httpStatus: 401,
  });
  expect(store.save).toHaveBeenCalledWith('https://server.test/', undefined);
  expect(revoked.factory).not.toHaveBeenCalled();
});

it('uses authenticated conversation search endpoints and preserves settings and errors', async () => {
  const { client, calls } = harness({
    search: (_url, init) =>
      init.method === 'POST' && String(init.body).includes('false')
        ? Response.json({ text: { key: 'chatSearchDisabled' } }, { status: 503 })
        : Response.json([]),
  });
  await client.connect('http://localhost:3077/mount/connect?token=test');
  try {
    await client.searchChats('杭州 bicycle', 7);
    await client.chatSearchStatus();
    await client.rebuildChatSearch();
    await expect(
      client.configureChatSearch({
        enabled: false,
        semantic: false,
        embeddings: { source: 'local', cloudConsent: false },
      }),
    ).rejects.toMatchObject({ text: { key: 'chatSearchDisabled' } });
    const requests = calls.filter((call) => call.url.includes('/swiftnest/api/search'));
    expect(requests.map((call) => new URL(call.url).pathname)).toEqual([
      '/mount/swiftnest/api/search',
      '/mount/swiftnest/api/search/status',
      '/mount/swiftnest/api/search/rebuild',
      '/mount/swiftnest/api/search/settings',
    ]);
    expect(new URL(requests[0]!.url).searchParams.get('query')).toBe('杭州 bicycle');
    expect(new URL(requests[0]!.url).searchParams.get('limit')).toBe('7');
    expect(
      requests.every((request) => (request.init.headers as Record<string, string>).cookie === 'dsh_api=secret'),
    ).toBe(true);
  } finally {
    client.close();
  }
});
