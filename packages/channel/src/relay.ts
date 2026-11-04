import { decodeBytes, encodeBytes, type ChannelSocket } from './index.js';

export const RELAY_PATH = '/swiftnest/relay';
export const RELAY_MAX_FRAME = 128 * 1024;
export const RELAY_MAX_MESSAGE = 64 * 1024;
export interface RelayConfig {
  address: string;
  secret: string;
}
export function relayAddress(value: string): string {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid relay address');
  return url.href;
}
export function relayConfig(value: unknown): RelayConfig | undefined {
  if (value === undefined || value === null) return;
  const config = value as RelayConfig;
  if (typeof config.secret !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(config.secret))
    throw new Error('Invalid relay secret');
  return { address: relayAddress(config.address), secret: config.secret };
}
/** SHA-256 of the pinned R1 Ed25519 public key, with a domain separator. */
export async function relayServerId(key: string): Promise<string> {
  const bytes = decodeBytes(key);
  if (bytes.length !== 32) throw new Error('Invalid server key');
  const prefix = new TextEncoder().encode('swiftnest/relay/v1:');
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  return encodeBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}
export function relaySocketUrl(address: string): string {
  const url = new URL(RELAY_PATH, relayAddress(address));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export interface RelayHello {
  role: 'server' | 'app';
  id: string;
  secret: string;
}
/** Only the bounded TLS-protected registration is clear to the relay. Noise starts after pairing. */
export function joinRelay<T = void>(
  socket: ChannelSocket,
  hello: RelayHello,
  signal: AbortSignal,
  registered?: () => void,
  paired?: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', register);
      socket.removeEventListener('close', fail);
      socket.removeEventListener('error', fail);
      socket.removeEventListener('message', received);
      signal.removeEventListener('abort', fail);
    };
    const fail = () => {
      cleanup();
      socket.close();
      reject(new Error('Relay unavailable'));
    };
    const register = () => socket.send(new TextEncoder().encode(JSON.stringify(hello)));
    const received = ({ data }: { data: unknown }) => {
      try {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const body = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes as Uint8Array);
        if (body === '{"t":"waiting"}' && hello.role === 'server') {
          registered?.();
          return;
        }
        if (body !== '{"t":"paired"}') return fail();
        cleanup();
        // Attach Noise before returning to the socket reader: its first record
        // can arrive in the same read as the relay's paired acknowledgement.
        resolve(paired ? paired() : (undefined as T));
      } catch {
        fail();
      }
    };
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', received);
    socket.addEventListener('open', register);
    socket.addEventListener('close', fail);
    socket.addEventListener('error', fail);
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) fail();
    else if (socket.readyState === 1) register();
  });
}
export function relayRoute(path: string): boolean {
  const pathname = new URL(path, 'http://channel').pathname;
  return !/^\/swiftnest\/api\/devices\/(live|transfers)(\/|$)/.test(pathname);
}
