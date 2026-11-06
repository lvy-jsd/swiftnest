/** A channel is an App carrier, never a generic HTTP proxy or a new API. */
const get = [
  /^\/swiftnest\/api\/tools$/,
  /^\/swiftnest\/api\/approvals(?:\/events)?$/,
  /^\/swiftnest\/api\/search(?:\/status)?$/,
  /^\/swiftnest\/health$/,
  /^\/swiftnest\/relay(?:\/connection)?$/,
  /^\/swiftnest\/api\/devices\/?$/,
  /^\/swiftnest\/api\/devices\/(preferences|transfers|approvals|pairing|audit|events)$/,
  /^\/swiftnest\/api\/devices\/files$/,
  /^\/swiftnest\/api\/plugins$/,
  /^\/swiftnest\/api\/models$/,
  /^\/swiftnest\/api\/memory(?:\/(?:topic|auto|auto\/recent))?$/,
];
const post = [
  /^\/swiftnest\/api\/tools\/apply$/,
  /^\/swiftnest\/api\/tools\/mcp\/[a-z0-9-]+\/(enable|disable)$/,
  /^\/swiftnest\/api\/tools\/capability\/[a-z0-9][a-z0-9-]{0,47}(?:\/delete)?$/,
  /^\/swiftnest\/api\/approvals\/settings$/,
  /^\/swiftnest\/api\/approvals\/[^/]+\/(allow|deny)$/,
  /^\/swiftnest\/api\/search\/(settings|rebuild)$/,
  /^\/swiftnest\/relay$/,
  /^\/api\/(session\/(list|create|attachment)|userQuestions\/answer|\$events\/result)$/,
  /^\/swiftnest\/native\/(issue|resume|rotate|bind|revoke)$/,
  /^\/swiftnest\/api\/chat$/,
  /^\/swiftnest\/api\/memory\/(add|edit|delete|topic|auto)$/,
  /^\/swiftnest\/api\/devices\/(preferences|transfers|pairing|live)$/,
  /^\/swiftnest\/api\/devices\/transfers\/[a-f0-9]{64}\/(pause|resume|cancel|retry)$/,
  /^\/swiftnest\/api\/devices\/(pairing|approvals)\/[^/]+\/(approve|deny)$/,
  /^\/swiftnest\/api\/devices\/revoke\/[^/]+$/,
  /^\/swiftnest\/api\/plugins\/apply$/,
  /^\/swiftnest\/api\/plugins\/[^/]+\/(enable|disable)$/,
  /^\/swiftnest\/api\/models\/(settings|apply)$/,
  /^\/swiftnest\/api\/models\/keys\/[a-z0-9-]+$/,
];
export function channelRoute(method: string, path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\r\n\0]/.test(path)) return false;
  const url = new URL(path, 'http://channel');
  if (`${url.pathname}${url.search}` !== path || /%2[ef]|%5c|%25/i.test(url.pathname)) return false;
  if (method === 'WS') return url.pathname === '/api/remote.mux' || url.pathname === '/swiftnest/api/devices/live';
  return (method === 'GET' ? get : method === 'POST' ? post : []).some((route) => route.test(url.pathname));
}
export interface ChannelFrame {
  t: 'auth' | 'ready' | 'request' | 'response' | 'data' | 'end' | 'socket' | 'opened' | 'message' | 'cancel' | 'error';
  id?: number;
  path?: string;
  method?: string;
  cookie?: string;
  token?: string;
  ticket?: string;
  browser?: boolean;
  interactions?: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
  binary?: boolean;
  pairing?: import('./index.js').ChannelPairing;
  relaySecret?: string;
}
export function channelFrame(value: unknown): ChannelFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid channel frame');
  return value as ChannelFrame;
}

/** Limit the existing DSH mux to the streams the App actually uses. */
export function appMuxFrame(body: string, binary = false): boolean {
  if (binary) return false;
  try {
    const frame = JSON.parse(body);
    return (
      typeof frame.streamId === 'string' &&
      frame.streamId.length <= 128 &&
      (frame.type === 'cancel' ||
        (frame.type === 'open' && ['$events', 'session/follow', 'userQuestions/attachWait'].includes(frame.endpoint)))
    );
  } catch {
    return false;
  }
}
