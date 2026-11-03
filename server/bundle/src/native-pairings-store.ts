/** Parent is the sole writer. The DSH child rereads for every admission: revocation never uses a stale cache. */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { isNativePairingCredential } from '@swiftnest/protocol';
const LIFETIME = 365 * 24 * 60 * 60 * 1000;
export interface NativeGrant {
  principal: { kind: 'owner' };
  interactions: 'answer' | 'none';
}
export interface NativePairing extends NativeGrant {
  id: string;
  hash: string;
  audience: string;
  name: string;
  kind: 'desktop' | 'android';
  createdAt: number;
  expiresAt: number;
  device?: string;
  fingerprint?: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

/** No launch tokens, cookies or plaintext credentials are ever written here. */
export class NativePairings {
  constructor(readonly file: string) {}

  list(): NativePairing[] {
    try {
      const records: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid native pairing store');
      return records.filter(
        (r): r is NativePairing =>
          r?.principal?.kind === 'owner' &&
          ['answer', 'none'].includes(r.interactions) &&
          typeof r.hash === 'string' &&
          typeof r.id === 'string' &&
          typeof r.audience === 'string' &&
          typeof r.expiresAt === 'number' &&
          r.expiresAt > Date.now(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  verify(credential: string, audience: string): NativePairing | undefined {
    if (!isNativePairingCredential(credential)) return undefined;
    const digest = hash(credential);
    return this.list().find((r) => r.hash === digest && r.audience === audience);
  }

  issue(grant: NativeGrant, audience: string, name = 'Swiftnest', kind: NativePairing['kind'] = 'desktop') {
    // Deliberately support only the principal currently issued by pinned DSH /connect.
    // Future device/agent principals must get an explicit design, never an owner fallback.
    if (grant.principal.kind !== 'owner' || !['answer', 'none'].includes(grant.interactions))
      throw new Error('Unsupported native grant');
    const credential = secret();
    const record: NativePairing = {
      principal: { kind: 'owner' },
      interactions: grant.interactions,
      id: `app-${randomBytes(12).toString('hex')}`,
      hash: hash(credential),
      audience,
      name: name.slice(0, 80),
      kind,
      createdAt: Date.now(),
      expiresAt: Date.now() + LIFETIME,
    };
    this.save([...this.list(), record]);
    return { credential, record };
  }

  /** Explicit rotation invalidates the old token, preserves scope and never extends absolute expiry. */
  rotate(credential: string, audience: string) {
    const record = this.verify(credential, audience);
    if (!record) return undefined;
    const next = secret();
    this.save(this.list().map((r) => (r.id === record.id ? { ...r, hash: hash(next) } : r)));
    return { credential: next };
  }

  bind(credential: string, audience: string, device: string, fingerprint: string): boolean {
    const record = this.verify(credential, audience);
    if (!record) return false;
    if (record.device !== device || record.fingerprint !== fingerprint)
      this.save(this.list().map((r) => (r.id === record.id ? { ...r, device, fingerprint } : r)));
    return true;
  }

  revoke(device: string): boolean {
    const records = this.list();
    const next = records.filter((r) => r.id !== device && r.device !== device);
    if (next.length === records.length) return false;
    this.save(next);
    return true;
  }

  private save(records: NativePairing[]): void {
    // Parent serializes synchronous mutations; atomic rename makes child reads safe.
    writeFileSync(`${this.file}.tmp`, JSON.stringify(records), { mode: 0o600 });
    chmodSync(`${this.file}.tmp`, 0o600);
    renameSync(`${this.file}.tmp`, this.file);
  }
}
