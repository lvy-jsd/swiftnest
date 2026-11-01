/**
 * Phase-0 pairing: the App trades the kernel's launch token for an API cookie
 * at `/connect`. The token changes on every restart; per-device credentials
 * replace this with the gateway module.
 */
export function pairingUrl(rootUrl: string, token: string): string {
  const url = new URL("connect", rootUrl.endsWith("/") ? rootUrl : `${rootUrl}/`);
  url.searchParams.set("token", token);
  url.searchParams.set("interactions", "answer");
  return url.toString();
}
