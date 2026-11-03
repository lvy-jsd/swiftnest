/**
 * Initial pairing: /connect trades the kernel's launch token for an API cookie.
 * Native Apps then exchange that bootstrap for their own revocable, durable credential;
 * reconnect never needs the launch token again.
 */
export function pairingUrl(rootUrl: string, token: string): string {
  const url = new URL('connect', rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`);
  url.searchParams.set('token', token);
  url.searchParams.set('interactions', 'answer');
  return url.toString();
}

export function webAppUrl(rootUrl: string, token: string): string {
  return new URL(`app/#/pair?url=${encodeURIComponent(pairingUrl(rootUrl, token))}`, rootUrl).href;
}
