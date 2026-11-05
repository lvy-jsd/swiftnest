import { afterEach, expect, it, vi } from 'vitest';
import { approvalAnswerer } from '../src/approval-inbox.js';

afterEach(() => vi.unstubAllGlobals());
it('uses the newest raw arguments when a model reuses a tool-call identifier across turns', async () => {
  const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json(true));
  vi.stubGlobal('fetch', request);
  let answer!: Parameters<Parameters<typeof approvalAnswerer>[0]['on']>[1];
  approvalAnswerer(
    {
      on(_event, listener, prepend) {
        expect(prepend).toBe(true);
        answer = listener;
        return () => {};
      },
      effect(fn) {
        fn();
      },
    },
    { devicesAdminUrl: 'http://127.0.0.1:1', devicesAdminToken: 'test-admin' },
  );
  const events = [
    { type: 'session/title', data: { title: 'My chat' } },
    { type: 'tool/call', data: { callId: 'repeated', arguments: '{"path":"/old"}' } },
    { type: 'tool/call', data: { callId: 'repeated', arguments: '{"path":"/new"}' } },
    { type: 'approval/asked', data: { callId: 'repeated', id: 'pending' } },
  ];
  const outcome = await answer({
    agent: { id: 'chat', session: { seq: events.length, eventAt: (seq) => events[seq] } },
    callId: 'repeated',
    toolName: 'read',
    reason: 'Read this?',
  });
  expect(outcome).toBe('allowed-once');
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
    id: 'pending',
    requester: 'My chat',
    args: { path: '/new' },
  });
});
