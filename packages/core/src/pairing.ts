/**
 * Pairing (design §7.2) and the list of paired devices.
 *
 * The owner starts pairing on the Nest and gets a one-time 6-digit code (5 minutes). The device proves it knows the
 * code with an HMAC bound to the encrypted session, so the code never crosses the wire. A code alone is not enough: a
 * man in the middle could guess a 6-digit code offline from what it relays. So both people then compare short
 * fingerprints — the Nest shows the device's, the device shows the Nest's — and both must say yes.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SwiftnestFailure } from "./errors.js";
import { fingerprintOf } from "./identity.js";

export interface PairedDevice {
  device: string;
  publicKey: string;
  pairedAt: string;
  /** Stable agent namespace, assigned by the store on first pairing. */
  slug: string;
  name: string;
  kind: 'desktop' | 'android';
}

export type PairingRecord = Omit<PairedDevice, 'slug' | 'name' | 'kind'> & Partial<Pick<PairedDevice, 'slug' | 'name' | 'kind'>>;

export function deviceSlug(name: string, used: Iterable<string> = []): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'device';
  const taken = new Set(used);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    const suffix = `-${n}`;
    slug = base.slice(0, 24 - suffix.length) + suffix;
  }
  return slug;
}

export interface DeviceStore {
  list(): PairedDevice[];
  get(device: string): PairedDevice | undefined;
  add(entry: PairingRecord): Promise<void>;
  remove(device: string): Promise<boolean>;
  onChange?(fn: () => void): () => void;
}

export class MemoryDeviceStore implements DeviceStore {
  protected entries = new Map<string, PairedDevice>();
  private listeners = new Set<() => void>();
  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  protected changed() { for (const fn of this.listeners) fn(); }
  list() {
    return [...this.entries.values()].map(d => ({ ...d }));
  }
  get(device: string) {
    const entry = this.entries.get(device);
    return entry && { ...entry };
  }
  async add(entry: PairingRecord) {
    const previous = this.entries.get(entry.device);
    const used = this.list().filter(d => d.device !== entry.device).map(d => d.slug!);
    const requested = entry.slug;
    const slug = previous?.slug ?? (requested && /^[a-z0-9_-]{1,24}$/.test(requested) && !used.includes(requested) ? requested : deviceSlug(entry.name ?? entry.device, used));
    this.entries.set(entry.device, { ...entry, slug, name: entry.name ?? previous?.name ?? entry.device, kind: entry.kind ?? previous?.kind ?? 'desktop' });
    this.changed();
  }
  async remove(device: string) {
    const removed = this.entries.delete(device);
    if (removed) this.changed();
    return removed;
  }
}

/** Paired devices in a JSON file (mode 600), written atomically. */
export class JsonDeviceStore extends MemoryDeviceStore {
  private writes = Promise.resolve();
  private constructor(private path: string) {
    super();
  }

  static async open(path: string): Promise<JsonDeviceStore> {
    const store = new JsonDeviceStore(path);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as { devices?: PairingRecord[] };
      // Reserve valid existing slugs before assigning namespaces to legacy records.
      const records = raw.devices ?? [];
      const reserved = new Set(records.map(d => d.slug).filter((s): s is string => !!s && /^[a-z0-9_-]{1,24}$/.test(s)));
      const assigned = new Set<string>();
      let migrated = false;
      for (const d of records) {
        const slug = d.slug && /^[a-z0-9_-]{1,24}$/.test(d.slug) && !assigned.has(d.slug) ? d.slug : deviceSlug(d.name ?? d.device, [...reserved, ...assigned]);
        assigned.add(slug);
        const entry = { ...d, slug, name: d.name ?? d.device, kind: d.kind ?? 'desktop' as const };
        store.entries.set(d.device, entry);
        migrated ||= JSON.stringify(entry) !== JSON.stringify(d);
      }
      if (migrated) await store.save();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SwiftnestFailure("STORE_CORRUPT", `Cannot read the paired devices file ${path}.`, "Fix or delete the file; deleting it means pairing every device again.");
    }
    return store;
  }

  override async add(entry: PairingRecord) {
    await super.add(entry);
    await this.save();
  }

  override async remove(device: string) {
    const removed = await super.remove(device);
    if (removed) await this.save();
    return removed;
  }

  private save(): Promise<void> {
    const data = JSON.stringify({ devices: this.list() }, null, 2) + "\n";
    const saved = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writes = saved.catch(() => {});
    return saved;
  }
}

/** HMAC the device sends instead of the code: bound to this session's handshake transcript. */
export function pairingProof(code: string, transcriptHash: Buffer): string {
  return createHmac("sha256", code).update("swiftnest/pair/v1\0").update(transcriptHash).digest("base64url");
}

export interface PairingCandidate {
  id: string;
  device: string;
  publicKey: string;
  fingerprint: string;
}

export interface PairingOptions {
  ttlMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export class PairingManager {
  private code: { value: string; expiresAt: number; attempts: number } | undefined;
  private candidates = new Map<string, { candidate: PairingCandidate; decide: (accept: boolean) => void }>();
  private listeners = new Set<(c: PairingCandidate) => void>();
  private changes = new Set<() => void>();
  private seq = 0;
  private ttlMs: number;
  private maxAttempts: number;
  private now: () => number;

  constructor(o: PairingOptions = {}) {
    this.ttlMs = o.ttlMs ?? 5 * 60_000;
    this.maxAttempts = o.maxAttempts ?? 5;
    this.now = o.now ?? Date.now;
  }

  /** New one-time code; any earlier code stops working. */
  start(): { code: string; expiresAt: string } {
    const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = this.now() + this.ttlMs;
    this.code = { value, expiresAt, attempts: 0 };
    return { code: value, expiresAt: new Date(expiresAt).toISOString() };
  }

  stop(): void {
    this.code = undefined;
  }

  get active(): boolean {
    return this.code !== undefined && this.now() < this.code.expiresAt;
  }

  /**
   * Check a device's proof. A right proof uses the code up (one device per code); wrong ones count towards the limit,
   * after which the code is dropped so it cannot be brute-forced online.
   */
  verify(proof: string, transcriptHash: Buffer): boolean {
    const code = this.code;
    if (!code || this.now() >= code.expiresAt) {
      this.code = undefined;
      return false;
    }
    const expected = Buffer.from(pairingProof(code.value, transcriptHash));
    const given = Buffer.from(proof);
    const ok = expected.length === given.length && timingSafeEqual(expected, given);
    if (ok) this.code = undefined;
    else if (++code.attempts >= this.maxAttempts) this.code = undefined;
    return ok;
  }

  /** Ask the owner; `answer` resolves with their decision (false after `timeoutMs` or on withdraw). */
  offer(device: string, publicKey: string, timeoutMs = 5 * 60_000): { candidate: PairingCandidate; answer: Promise<boolean> } {
    const id = `p${++this.seq}`;
    const candidate: PairingCandidate = { id, device, publicKey, fingerprint: fingerprintOf(publicKey) };
    let timer: NodeJS.Timeout;
    const answer = new Promise<boolean>((resolve) => {
      const decide = (accept: boolean) => {
        clearTimeout(timer);
        if (!this.candidates.delete(id)) return;
        resolve(accept);
        for (const fn of this.changes) fn();
      };
      timer = setTimeout(() => decide(false), timeoutMs);
      this.candidates.set(id, { candidate, decide });
    });
    for (const fn of this.listeners) fn(candidate);
    for (const fn of this.changes) fn();
    return { candidate, answer };
  }

  /** Withdraw a candidate whose connection went away. */
  withdraw(id: string): void {
    this.candidates.get(id)?.decide(false);
  }

  pending(): PairingCandidate[] {
    return [...this.candidates.values()].map((c) => c.candidate);
  }

  confirm(id: string, accept: boolean): boolean {
    const entry = this.candidates.get(id);
    if (!entry) return false;
    entry.decide(accept);
    return true;
  }

  onChange(fn: () => void): () => void {
    this.changes.add(fn);
    return () => { this.changes.delete(fn); };
  }

  onCandidate(fn: (c: PairingCandidate) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
