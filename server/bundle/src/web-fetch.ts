/** Product-scoped HTTP provider: pin validated DNS answers on every redirect hop.
 * Deliberately direct transport (no ambient proxy): a proxy could re-resolve a safe
 * hostname into a private destination. Does not restrict operator model/MCP URLs.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { WebFetchProvider, WebFetchResult } from '@deepseek-ai/dsh-web';

export const name = 'swiftnest-web-fetch';
export const inject = ['web'];
export interface Config {
  allowOrigins?: string[];
}
type Address = { address: string; family: number };
export type Resolver = (host: string) => Promise<Address[]>;
const resolve: Resolver = (host) => lookup(host, { all: true });

/** Exact origins, not wildcard hosts or arbitrary URLs; grants include their resolved private IPs. */
export function allowedOrigins(values: unknown = []): Set<string> {
  if (!Array.isArray(values)) throw new Error('webFetch.allowOrigins must be an array of exact HTTP(S) origins');
  return new Set(
    values.map((value) => {
      if (typeof value !== 'string') throw new Error('webFetch.allowOrigins must contain strings');
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error('webFetch.allowOrigins accepts exact HTTP(S) origins only');
      return url.origin;
    }),
  );
}
export function publicAddress(input: string): boolean {
  try {
    const parsed = ipaddr.process(input);
    // Conservatively reject all transition/translation/reserved ranges too.
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function destination(
  raw: string,
  allow: Set<string>,
  resolver = resolve,
): Promise<{ url: URL; addresses: Address[] }> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || raw.length > 2048)
    throw new Error('WEB_BLOCKED_URL: only HTTP(S) URLs without credentials are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolver(host);
  if (!addresses.length || addresses.some((entry) => !isIP(entry.address) || ![4, 6].includes(entry.family)))
    throw new Error('WEB_BLOCKED_URL: invalid or empty DNS answer');
  if (!allow.has(url.origin) && addresses.some((entry) => !publicAddress(entry.address)))
    throw new Error('WEB_BLOCKED_URL: non-public destination requires webFetch.allowOrigins');
  return { url, addresses };
}

export function createProvider(config: Config = {}, resolver = resolve): WebFetchProvider {
  const allow = allowedOrigins(config.allowOrigins);
  return {
    id: 'http',
    available: () => true,
    async fetch(input, parent): Promise<WebFetchResult> {
      const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      let raw = input.url;
      for (let hop = 0; hop <= 5; hop++) {
        signal.throwIfAborted();
        const { url, addresses } = await destination(raw, allow, resolver);
        signal.throwIfAborted();
        const response = await new Promise<import('node:http').IncomingMessage>((resolveResponse, reject) => {
          const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
            url,
            {
              signal,
              agent: false,
              headers: {
                'user-agent': 'swiftnest-web-fetch',
                accept: 'text/html,text/plain,application/json',
                'accept-encoding': 'identity',
              },
              // Keep URL hostname for Host/TLS SNI, but never resolve it again at connect time.
              lookup(_hostname, options, callback) {
                const eligible = addresses.filter((entry) => !options.family || entry.family === options.family);
                const chosen = eligible[0];
                if (!chosen) {
                  callback(new Error('No validated address in requested family'), '', 4);
                  return;
                }
                if (options.all) callback(null, eligible);
                else callback(null, chosen.address, chosen.family);
              },
            },
            resolveResponse,
          );
          request.on('error', reject);
          request.end();
        });
        try {
          const statusCode = response.statusCode ?? 500;
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            if (!response.headers.location || hop === 5) throw new Error('WEB_REDIRECT_BLOCKED');
            raw = new URL(response.headers.location, url).href;
            continue;
          }
          const mime = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (
            !(
              mime.startsWith('text/') ||
              ['application/xhtml+xml', 'application/json', 'application/xml'].includes(mime) ||
              mime.endsWith('+json') ||
              mime.endsWith('+xml')
            )
          )
            throw new Error('WEB_UNSUPPORTED_CONTENT_TYPE');
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
            throw new Error('WEB_UNSUPPORTED_CONTENT_ENCODING');
          const chunks: Buffer[] = [];
          let length = 0;
          let truncated = false;
          for await (const value of response) {
            const chunk = Buffer.from(value);
            const remaining = 5_000_000 - length;
            chunks.push(chunk.subarray(0, remaining));
            length += Math.min(chunk.length, remaining);
            if (chunk.length > remaining) {
              truncated = true;
              break;
            }
          }
          const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(response.headers['content-type'] ?? '')?.[1] ?? 'utf-8';
          const content = new TextDecoder(charset).decode(Buffer.concat(chunks));
          return {
            url: url.href,
            statusCode,
            body: { kind: mime.includes('html') ? 'html' : 'text', content: content.slice(0, 100_000) },
            truncated: truncated || content.length > 100_000,
          };
        } finally {
          response.destroy();
        }
      }
      throw new Error('WEB_REDIRECT_BLOCKED');
    },
  };
}
export function apply(ctx: { web: { registerFetchProvider(provider: WebFetchProvider): unknown } }, config: Config) {
  ctx.web.registerFetchProvider(createProvider(config));
}
