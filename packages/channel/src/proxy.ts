/** Trust only the last address appended by one explicitly trusted immediate proxy. */
export function clientAddress(
  req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } },
  trustedProxyIp?: string,
): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (!trustedProxyIp || direct !== trustedProxyIp || typeof forwarded !== 'string') return direct;
  const address = forwarded.split(',').at(-1)!.trim();
  try {
    const host = address.includes(':') ? `[${address}]` : address;
    const parsed = new URL(`http://${host}/`);
    if (address.includes(':')) return parsed.hostname.slice(1, -1);
    return parsed.hostname === host && /^\d+\.\d+\.\d+\.\d+$/.test(address) ? address : direct;
  } catch {
    return direct;
  }
}
