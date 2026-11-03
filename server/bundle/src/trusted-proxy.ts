import type { IncomingMessage } from 'node:http';

export function trustedProxyOrigin(env = process.env): string | undefined {
  if (!env.SWIFTNEST_TRUSTED_PROXY_IP || !env.SWIFTNEST_TRUSTED_PROXY_ORIGIN) return;
  try {
    const url = new URL(env.SWIFTNEST_TRUSTED_PROXY_ORIGIN);
    if (
      url.protocol === 'https:' &&
      url.origin === env.SWIFTNEST_TRUSTED_PROXY_ORIGIN &&
      !url.username &&
      !url.password
    )
      return url.origin;
  } catch {
    return;
  }
}

export function channelAddresses(lan: string, env = process.env): string[] {
  const external = trustedProxyOrigin(env);
  return [...new Set(external ? [`${external}/`, lan] : [lan])];
}

/** Default off. Trust one explicit local proxy IP and one exact HTTPS origin, never arbitrary forwarded headers. */
export function normalizeChannelProxy(req: IncomingMessage, target: URL, env = process.env): boolean {
  const address = env.SWIFTNEST_TRUSTED_PROXY_IP;
  const origin = env.SWIFTNEST_TRUSTED_PROXY_ORIGIN;
  if (!address && !origin) return true;
  if (!address || !origin) return false;
  const configured = trustedProxyOrigin(env);
  if (!configured) return false;
  const external = new URL(configured);
  if (req.socket.remoteAddress !== address)
    return req.headers.host === target.host && (!req.headers.origin || req.headers.origin === target.origin);
  if (
    ![external.host, target.host].includes(req.headers.host ?? '') ||
    (req.headers.origin && ![external.origin, target.origin].includes(req.headers.origin))
  )
    return false;
  req.headers.host = target.host;
  if (req.headers.origin) req.headers.origin = target.origin;
  return true;
}
