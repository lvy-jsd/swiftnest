import { expect, it } from 'vitest';
import { joinRelay, type ChannelSocket } from '@swiftnest/channel';

it('hands a coalesced relay acknowledgement and first Noise record to Noise without a listener gap', async () => {
  const listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
  const emit = (data: unknown) => {
    // Snapshot, like a real socket: a listener added during this event receives only the next event.
    for (const listener of [...(listeners.get('message') ?? [])]) listener({ data });
  };
  const socket: ChannelSocket = {
    readyState: 1,
    send() {
      queueMicrotask(() => {
        emit('{"t":"paired"}');
        emit(new Uint8Array([0, 255, 1]));
      });
    },
    close() {},
    addEventListener(type, listener) {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  const bytes = await joinRelay(
    socket,
    { role: 'server', id: 'a'.repeat(43), secret: 's'.repeat(32) },
    AbortSignal.timeout(1000),
    undefined,
    () =>
      new Promise<unknown>((resolve) => {
        socket.addEventListener('message', ({ data }) => resolve(data));
      }),
  );
  expect(bytes).toEqual(new Uint8Array([0, 255, 1]));
});
