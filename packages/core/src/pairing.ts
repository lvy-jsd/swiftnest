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
}

export interface DeviceStore {
  list(): PairedDevice[];
  get(device: string): PairedDevice | undefined;
  add(entry: PairedDevice): Promise<void>;
  remove(device: string): Promise<boolean>;
}

export class MemoryDeviceStore implements DeviceStore {
  protected entries = new Map<string, PairedDevice>();
  list() {
    return [...this.entries.values()];
  }
  get(device: string) {
    return this.entries.get(device);
  }
  async add(entry: PairedDevice) {
    this.entries.set(entry.device, entry);
  }
  async remove(device: string) {
    return this.entries.delete(device);
  }
}

/** Paired devices in a JSON file (mode 600), written atomically. */
export class JsonDeviceStore extends MemoryDeviceStore {
  private constructor(private path: string) {
    super();
  }

  static async open(path: string): Promise<JsonDeviceStore> {
    const store = new JsonDeviceStore(path);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as { devices?: PairedDevice[] };
      for (const d of raw.devices ?? []) store.entries.set(d.device, d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SwiftnestFailure("STORE_CORRUPT", `Cannot read the paired devices file ${path}.`, "Fix or delete the file; deleting it means pairing every device again.");
    }
    return store;
  }

  override async add(entry: PairedDevice) {
    await super.add(entry);
    await this.save();
  }

  override async remove(device: string) {
    const removed = await super.remove(device);
    if (removed) await this.save();
    return removed;
  }

  private async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ devices: this.list() }, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.path);
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
      };
      timer = setTimeout(() => decide(false), timeoutMs);
      this.candidates.set(id, { candidate, decide });
    });
    for (const fn of this.listeners) fn(candidate);
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

  onCandidate(fn: (c: PairingCandidate) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
