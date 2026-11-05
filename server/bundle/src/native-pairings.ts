/** Pinned DSH rc.5 exposes createPeer but no admission provider registry; wrap only its public admit method. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { NativePairings, type NativeGrant, type NativePairing } from './native-pairings-store.js';
import { NATIVE_PAIRING_COOKIE as NATIVE_COOKIE } from '@swiftnest/protocol';
import type { DeviceConnection } from './devices.js';

type Request = Pick<IncomingMessage, 'headers'> & Partial<Pick<IncomingMessage, 'socket'>>;
interface NativePeer {
  approvalDevice?: string;
  principal: { kind: string };
  interactions?: 'answer' | 'none';
  signal: AbortSignal;
  dispose(): Promise<void>;
}
export interface NativeConnection extends DeviceConnection {
  browserPeer?: NativePeer;
  createPeer(grant: NativeGrant): NativePeer;
}
export function nativeCredential(req: Request): string | undefined {
  const matches = (req.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${NATIVE_COOKIE}=`));
  return matches.length === 1 ? matches[0]!.slice(NATIVE_COOKIE.length + 1) : undefined;
}
function audience(req: Request): string {
  // Match DSH's direct listener authority; forwarded headers never participate.
  const protocol = (req.socket as import('node:tls').TLSSocket | undefined)?.encrypted ? 'https:' : 'http:';
  return `${protocol}//${req.headers.host?.toLowerCase() ?? ''}`;
}

class NativeAdmission {
  private peers = new Map<string, { peer: NativePeer; credential: string; audience: string; expiresAt: number }>();
  private signature?: string;
  private expiry?: ReturnType<typeof setTimeout>;
  readonly original: NativeConnection['admit'];
  constructor(
    private connection: NativeConnection,
    private store: NativePairings,
  ) {
    this.original = connection.admit;
    connection.admit = (req) => this.admit(req);
  }
  private admit(req: Request): ReturnType<DeviceConnection['admit']> {
    const admission = this.original.call(this.connection, req);
    // Original 403 is the Host/Origin fence. A native credential never bypasses it.
    if ('rejection' in admission && admission.rejection === 403) return admission;
    const credential = nativeCredential(req);
    if (!credential) {
      if ((req.headers.cookie ?? '').includes(`${NATIVE_COOKIE}=`)) return { rejection: 401 };
      return 'peer' in admission && (admission.peer as NativePeer).signal?.aborted ? { rejection: 401 } : admission;
    }
    try {
      const record = this.store.verify(credential, audience(req));
      return record ? { peer: this.peer(record, credential) } : { rejection: 401 };
    } catch {
      return { rejection: 401 };
    }
  }
  private peer(record: NativePairing, credential: string): NativePeer {
    let entry = this.peers.get(record.id);
    if (entry && (entry.credential !== credential || entry.peer.signal.aborted)) {
      void entry.peer.dispose();
      this.peers.delete(record.id);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        credential,
        audience: record.audience,
        expiresAt: record.expiresAt,
        peer: this.connection.createPeer({
          principal: { kind: record.principal.kind },
          interactions: record.interactions,
        }),
      };
      this.peers.set(record.id, entry);
      this.scheduleExpiry();
    }
    entry.peer.approvalDevice = record.device ?? `app:${record.id}`;
    return entry.peer;
  }
  invalidate = () => {
    try {
      const stat = statSync(this.store.file, { bigint: true, throwIfNoEntry: false });
      // Atomic replacement, same-size writes and permission changes all count as changes.
      const signature = stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'missing';
      if (signature === this.signature) return;
      this.signature = signature;
    } catch {
      this.signature = undefined;
      this.disposePeers();
      return;
    }
    for (const [id, entry] of this.peers) {
      let record: NativePairing | undefined;
      try {
        record = this.store.verify(entry.credential, entry.audience);
      } catch {
        /* Fail closed. */
      }
      if (record) entry.expiresAt = record.expiresAt;
      else {
        this.peers.delete(id);
        void entry.peer.dispose();
      }
    }
    this.scheduleExpiry();
  };
  private scheduleExpiry(): void {
    clearTimeout(this.expiry);
    const next = Math.min(...[...this.peers.values()].map((entry) => entry.expiresAt));
    if (!Number.isFinite(next)) return;
    // Node clamps overflowing delays to 1 ms; long-lived grants need a bounded timer.
    this.expiry = setTimeout(this.expire, Math.min(Math.max(0, next - Date.now()), 2_147_483_647));
    this.expiry.unref();
  }
  private expire = () => {
    for (const [id, entry] of this.peers) {
      if (entry.expiresAt > Date.now()) continue;
      this.peers.delete(id);
      void entry.peer.dispose();
    }
    this.scheduleExpiry();
  };
  private disposePeers(): void {
    clearTimeout(this.expiry);
    for (const { peer } of this.peers.values()) void peer.dispose();
    this.peers.clear();
  }
  close() {
    this.connection.admit = this.original;
    this.disposePeers();
  }
}

export function nativePairings(connection: NativeConnection, home: string, endpoint: string, adminToken: string) {
  const target = new URL(endpoint);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/' ||
    target.search ||
    target.username ||
    target.password
  )
    throw new Error('Native pairing admin must use loopback');
  const store = new NativePairings(join(home, 'native-pairings.json'));
  const admission = new NativeAdmission(connection, store);
  // Only stat once a second in the background; parsing and verification run on changes.
  const sweep = setInterval(admission.invalidate, 1000);
  sweep.unref();
  return {
    invalidate: admission.invalidate,
    handler: nativeHandler(connection, target, adminToken, admission.invalidate),
    close() {
      clearInterval(sweep);
      admission.close();
    },
  };
}

function nativeHandler(connection: NativeConnection, endpoint: URL, adminToken: string, invalidate: () => void) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Native-only POST: no CSRF through browser cookies, no query credentials or redirects.
    if (req.method !== 'POST' || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const action = url.pathname.split('/').at(-1);
    if (
      url.search ||
      url.pathname !== `/swiftnest/native/${action}` ||
      !['issue', 'resume', 'rotate', 'bind', 'revoke'].includes(action ?? '')
    ) {
      res.writeHead(404).end();
      return;
    }
    const admission = connection.admit(req);
    if ('rejection' in admission) {
      res.writeHead(admission.rejection).end();
      return;
    }
    const credential = nativeCredential(req);
    const peer = admission.peer as NativePeer;
    if (action === 'issue' && (credential || peer.principal.kind !== 'owner' || peer === connection.browserPeer)) {
      res.writeHead(403).end();
      return;
    }
    if (action !== 'issue' && !credential) {
      res.writeHead(401).end();
      return;
    }
    const body = await nativeBody(req).catch(() => undefined);
    if (!body) {
      res.writeHead(400).end();
      return;
    }
    await forwardNative(
      req,
      res,
      endpoint,
      adminToken,
      {
        ...body,
        credential,
        audience: audience(req),
        grant: { principal: peer.principal, interactions: peer.interactions ?? 'none' },
      },
      invalidate,
      action === 'issue' ? peer : undefined,
    );
  };
}
async function forwardNative(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: URL,
  token: string,
  body: unknown,
  invalidate: () => void,
  exchanged?: NativePeer,
): Promise<void> {
  const action = req.url!.split('/').at(-1);
  try {
    const upstream = await fetch(new URL(`/swiftnest/control/native/${action}`, endpoint), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // The bootstrap API cookie cannot mint a replacement after the native pairing is revoked.
    if (upstream.ok && exchanged) await exchanged.dispose();
    invalidate();
    res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(await upstream.text());
  } catch {
    res.writeHead(503).end();
  }
}
async function nativeBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024) return undefined;
  }
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
