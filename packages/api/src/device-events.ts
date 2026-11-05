import { text } from '@swiftnest/protocol';
import type { DeviceEvent } from './devices.js';
import { ApiError, type Inbox } from './transport.js';

const eventTypes: DeviceEvent['type'][] = [
  'devices-changed',
  'approval-pending',
  'approvals-changed',
  'pairing-changed',
  'transfers-changed',
  'plugins-changed',
  'models-changed',
  'memory-changed',
];
function publishFrame(frame: string, inbox: Inbox<DeviceEvent>): void {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return;
  const event = JSON.parse(data) as DeviceEvent;
  if (!eventTypes.includes(event.type)) throw new ApiError('protocol-error', text('unknownDeviceEvent'));
  inbox.push(event);
}

/** The same bounded SSE decoder serves device and approval invalidations. */
export async function pumpDeviceEvents(
  body: ReadableStream<Uint8Array>,
  inbox: Inbox<DeviceEvent>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
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
        publishFrame(buffer.slice(0, end), inbox);
        buffer = buffer.slice(end + 2);
      }
    }
    inbox.end();
  } catch (error) {
    if (!signal.aborted) inbox.end(error instanceof Error ? error : new Error(String(error)));
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
