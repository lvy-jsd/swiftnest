/**
 * Secure channel: the same authenticated, encrypted session on every link (LAN, relay, Headscale…), whatever the link
 * itself provides (design §6). Node's built-in crypto only.
 *
 * Handshake (initiator = Perch, responder = Nest), two plaintext messages then everything encrypted:
 *   1. I → R  hs1 { v, role, device, id: I's Ed25519 key, eph: I's ephemeral X25519 key, nonce, pairing }
 *   2. R → I  hs2 { v, id: R's Ed25519 key, eph: R's ephemeral X25519 key, nonce }
 *   th   = SHA-256("swiftnest/handshake/v1" ‖ hs1 ‖ hs2)            (the exact strings sent)
 *   keys = HKDF-SHA-256(X25519(eph_I, eph_R), salt = th) → one AES-256-GCM key per direction
 *   3. both, encrypted: auth { sig: Ed25519(role ‖ th) }            (each side proves its identity key took part)
 * Frames after that are AES-256-GCM with a per-direction counter as the nonce; a frame out of order, replayed or
 * tampered with closes the channel. Who may connect (a paired key, a pinned Nest key, a pairing attempt) is decided by
 * the caller through `authorize`, after the identities are proven.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { SwiftnestFailure } from "./errors.js";
import { verifySignature, type Identity } from "./identity.js";

export const CHANNEL_VERSION = 1;
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** What a link plugin gives the channel: an ordered, reliable string pipe (a WebSocket, a stream…). */
export interface FrameTransport {
  send(data: string): void;
  onMessage(fn: (data: string) => void): () => void;
  onClose(fn: (reason?: string) => void): () => void;
  close(reason?: string): void;
}

export interface SecureChannel {
  /** The peer's proven Ed25519 public key (base64url). */
  readonly peerPublicKey: string;
  /** Hash of the handshake transcript: binds pairing proofs to this exact session. */
  readonly transcriptHash: Buffer;
  send(message: unknown): void;
  onMessage(fn: (message: unknown) => void): () => void;
  onClose(fn: (reason?: string) => void): () => void;
  close(reason?: string): void;
}

export interface Hello1 {
  t: "hs1";
  v: number;
  role: "perch";
  device: string;
  id: string;
  eph: string;
  nonce: string;
  pairing: boolean;
}
interface Hello2 {
  t: "hs2";
  v: number;
  id: string;
  eph: string;
  nonce: string;
}

function ephemeral() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(X25519_SPKI_PREFIX.length);
  return { privateKey, raw: Buffer.from(raw).toString("base64url") };
}

function x25519Key(raw: string): KeyObject {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) throw new SwiftnestFailure("HANDSHAKE_FAILED", "Malformed ephemeral key.");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
}

function transcript(hs1: string, hs2: string): Buffer {
  return createHash("sha256").update("swiftnest/handshake/v1\0").update(hs1).update("\0").update(hs2).digest();
}

function deriveKeys(privateKey: KeyObject, peerEph: string, th: Buffer) {
  const shared = diffieHellman({ privateKey, publicKey: x25519Key(peerEph) });
  const okm = Buffer.from(hkdfSync("sha256", shared, th, "swiftnest/keys/v1", 64));
  return { i2r: okm.subarray(0, 32), r2i: okm.subarray(32, 64) };
}

function authPayload(role: "perch" | "nest", th: Buffer) {
  return Buffer.concat([Buffer.from(`swiftnest/auth/v1/${role}\0`), th]);
}

function refusalHint(code: string): string | undefined {
  if (code === "NOT_PAIRED") return "Pair this device first: `swiftnest pair` on the Nest, then `swiftnest perch --pair <code>` here.";
  if (code === "PAIRING_CLOSED") return "Run `swiftnest pair` on the Nest first, then use the code it shows within 5 minutes.";
  return undefined;
}

/**
 * One listener on the transport from the very start, so a frame that arrives before its reader is ready (the peer's
 * auth right behind its hello) waits in the queue instead of being dropped.
 */
interface Inbox {
  next(timeoutMs: number, what: string): Promise<string>;
  /** Hand every later frame (and the queued ones) to `fn`. */
  drain(fn: (data: string) => void): void;
}

function inboxOf(t: FrameTransport): Inbox {
  const queue: string[] = [];
  let handler: ((data: string) => void) | undefined;
  let waiting: ((data: string) => void) | undefined;
  let closedReason: string | undefined;
  let closed = false;
  const failWaiting = new Set<(reason?: string) => void>();
  t.onMessage((data) => {
    if (handler) handler(data);
    else if (waiting) {
      const w = waiting;
      waiting = undefined;
      w(data);
    } else queue.push(data);
  });
  t.onClose((reason) => {
    closed = true;
    closedReason = reason;
    for (const fn of failWaiting) fn(reason);
  });
  return {
    next(timeoutMs, what) {
      return new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift()!);
        const fail = (reason?: string) => {
          clearTimeout(timer);
          failWaiting.delete(fail);
          waiting = undefined;
          const code = reason && /^[A-Z][A-Z0-9_]{2,40}$/.test(reason) ? reason : "HANDSHAKE_FAILED";
          reject(new SwiftnestFailure(code, `Connection closed during the ${what}${reason ? `: ${reason}` : ""}.`, refusalHint(code), code === "HANDSHAKE_FAILED"));
        };
        if (closed) return fail(closedReason);
        const timer = setTimeout(() => {
          failWaiting.delete(fail);
          waiting = undefined;
          reject(new SwiftnestFailure("HANDSHAKE_TIMEOUT", `The other side did not complete the ${what} in time.`, "Check that both sides run a compatible Swiftnest version.", true));
        }, timeoutMs);
        failWaiting.add(fail);
        waiting = (data) => {
          clearTimeout(timer);
          failWaiting.delete(fail);
          resolve(data);
        };
      });
    },
    drain(fn) {
      handler = fn;
      for (const data of queue.splice(0)) fn(data);
    },
  };
}

function parseJson<T>(data: string, type: string): T {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    throw new SwiftnestFailure("HANDSHAKE_FAILED", "Malformed handshake message.");
  }
  if (typeof v !== "object" || v === null || (v as { t?: unknown }).t !== type) throw new SwiftnestFailure("HANDSHAKE_FAILED", `Expected handshake message "${type}".`);
  return v as T;
}

const isKey = (s: unknown) => typeof s === "string" && Buffer.from(s, "base64url").length === 32;

/**
 * The encrypted session once keys exist. Messages are JSON; the first one each way must be `auth`.
 */
function encryptedSession(t: FrameTransport, inbox: Inbox, sendKey: Buffer, recvKey: Buffer, peerPublicKey: string, th: Buffer): SecureChannel & { firstMessage(timeoutMs: number): Promise<unknown> } {
  let sendCounter = 0n;
  let recvCounter = 0n;
  let closed = false;
  const listeners = new Set<(m: unknown) => void>();
  const backlog: unknown[] = [];
  let waiter: ((m: unknown) => void) | undefined;

  const nonceOf = (n: bigint) => {
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(n, 4);
    return b;
  };

  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    t.close(reason);
  };

  inbox.drain((data) => {
    if (closed) return;
    try {
      const frame = Buffer.from(data, "base64url");
      if (frame.length < 24 || frame.length > MAX_FRAME_BYTES) throw new Error("bad frame size");
      const counter = frame.readBigUInt64BE(0);
      if (counter !== recvCounter) throw new Error("frame out of order or replayed");
      const decipher = createDecipheriv("aes-256-gcm", recvKey, nonceOf(counter));
      decipher.setAuthTag(frame.subarray(frame.length - 16));
      const plain = Buffer.concat([decipher.update(frame.subarray(8, frame.length - 16)), decipher.final()]);
      recvCounter++;
      const message: unknown = JSON.parse(plain.toString("utf8"));
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(message);
      } else if (listeners.size) for (const fn of listeners) fn(message);
      else backlog.push(message);
    } catch {
      close("integrity check failed");
    }
  });
  t.onClose(() => {
    closed = true;
  });

  return {
    peerPublicKey,
    transcriptHash: th,
    send(message) {
      if (closed) throw new SwiftnestFailure("CHANNEL_CLOSED", "The connection is closed.", undefined, true);
      const cipher = createCipheriv("aes-256-gcm", sendKey, nonceOf(sendCounter));
      const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(message), "utf8")), cipher.final()]);
      const head = Buffer.alloc(8);
      head.writeBigUInt64BE(sendCounter, 0);
      sendCounter++;
      t.send(Buffer.concat([head, body, cipher.getAuthTag()]).toString("base64url"));
    },
    onMessage(fn) {
      listeners.add(fn);
      for (const m of backlog.splice(0)) fn(m);
      return () => listeners.delete(fn);
    },
    onClose: (fn) => t.onClose(fn),
    close,
    firstMessage(timeoutMs) {
      return new Promise((resolve, reject) => {
        if (backlog.length) return resolve(backlog.shift());
        const timer = setTimeout(() => reject(new SwiftnestFailure("HANDSHAKE_TIMEOUT", "The other side did not authenticate in time.", undefined, true)), timeoutMs);
        const off = t.onClose(() => {
          clearTimeout(timer);
          reject(new SwiftnestFailure("HANDSHAKE_FAILED", "Connection closed during authentication.", undefined, true));
        });
        waiter = (m) => {
          clearTimeout(timer);
          off();
          resolve(m);
        };
      });
    },
  };
}

async function exchangeAuth(session: ReturnType<typeof encryptedSession>, identity: Identity, myRole: "perch" | "nest", peerRole: "perch" | "nest", peerKey: string, th: Buffer, timeoutMs: number) {
  session.send({ type: "auth", sig: identity.sign(authPayload(myRole, th)) });
  const auth = (await session.firstMessage(timeoutMs)) as { type?: unknown; sig?: unknown };
  if (auth?.type !== "auth" || typeof auth.sig !== "string" || !verifySignature(peerKey, authPayload(peerRole, th), auth.sig)) {
    session.close("authentication failed");
    throw new SwiftnestFailure("AUTH_FAILED", "The other side could not prove its identity key.", "If this keeps happening, someone may be intercepting the connection; pair the device again.");
  }
}

export interface InitiateOptions {
  identity: Identity;
  device: string;
  /** Set while pairing: the Nest's key is not pinned yet and is shown to the user as a fingerprint instead. */
  pairing?: boolean;
  /** The pinned Nest key from an earlier pairing. Required unless pairing. */
  expectedPeer?: string;
  timeoutMs?: number;
}

/** Perch side. Resolves once both identities are proven; the Nest key is checked against `expectedPeer`. */
export async function initiateChannel(t: FrameTransport, o: InitiateOptions): Promise<SecureChannel> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const eph = ephemeral();
  const hs1: Hello1 = { t: "hs1", v: CHANNEL_VERSION, role: "perch", device: o.device, id: o.identity.publicKey, eph: eph.raw, nonce: randomBytes(16).toString("base64url"), pairing: Boolean(o.pairing) };
  const hs1Raw = JSON.stringify(hs1);
  const inbox = inboxOf(t);
  t.send(hs1Raw);
  const hs2Raw = await inbox.next(timeoutMs, "handshake");
  const hs2 = parseJson<Hello2>(hs2Raw, "hs2");
  if (hs2.v !== CHANNEL_VERSION) {
    t.close("version mismatch");
    throw new SwiftnestFailure("PROTOCOL_MISMATCH", `The Nest speaks channel v${hs2.v}, this device v${CHANNEL_VERSION}.`, "Upgrade Swiftnest on both machines to the same version.");
  }
  if (!isKey(hs2.id) || !isKey(hs2.eph)) {
    t.close("bad handshake");
    throw new SwiftnestFailure("HANDSHAKE_FAILED", "Malformed handshake from the Nest.");
  }
  if (!o.pairing && hs2.id !== o.expectedPeer) {
    t.close("unexpected nest key");
    throw new SwiftnestFailure("NEST_KEY_CHANGED", "The Nest at this address is not the one this device was paired with.", "If you reinstalled the Nest, pair this device again; otherwise someone may be impersonating it.");
  }
  const th = transcript(hs1Raw, hs2Raw);
  const keys = deriveKeys(eph.privateKey, hs2.eph, th);
  const session = encryptedSession(t, inbox, keys.i2r, keys.r2i, hs2.id, th);
  await exchangeAuth(session, o.identity, "perch", "nest", hs2.id, th, timeoutMs);
  return session;
}

export interface AcceptOptions {
  identity: Identity;
  timeoutMs?: number;
  /** Decide from the (not yet proven) hello whether to continue at all; throw to refuse early. */
  screen?(hello: Hello1): void;
}

/** Nest side. Resolves with the proven channel and the Perch's hello; the caller decides what the Perch may do. */
export async function acceptChannel(t: FrameTransport, o: AcceptOptions): Promise<{ channel: SecureChannel; hello: Hello1 }> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const inbox = inboxOf(t);
  const hs1Raw = await inbox.next(timeoutMs, "handshake");
  const hello = parseJson<Hello1>(hs1Raw, "hs1");
  if (hello.v !== CHANNEL_VERSION) {
    t.close("version mismatch");
    throw new SwiftnestFailure("PROTOCOL_MISMATCH", `A device speaks channel v${hello.v}, this Nest v${CHANNEL_VERSION}.`, "Upgrade Swiftnest on both machines to the same version.");
  }
  if (!isKey(hello.id) || !isKey(hello.eph) || typeof hello.device !== "string") {
    t.close("bad handshake");
    throw new SwiftnestFailure("HANDSHAKE_FAILED", "Malformed handshake from a device.");
  }
  try {
    o.screen?.(hello);
  } catch (e) {
    // The reason is a bare error code, so the device can tell "pair first" from a network failure.
    t.close(e instanceof SwiftnestFailure ? e.code : "REFUSED");
    throw e;
  }
  const eph = ephemeral();
  const hs2: Hello2 = { t: "hs2", v: CHANNEL_VERSION, id: o.identity.publicKey, eph: eph.raw, nonce: randomBytes(16).toString("base64url") };
  const hs2Raw = JSON.stringify(hs2);
  const th = transcript(hs1Raw, hs2Raw);
  const keys = deriveKeys(eph.privateKey, hello.eph, th);
  const session = encryptedSession(t, inbox, keys.r2i, keys.i2r, hello.id, th);
  t.send(hs2Raw);
  await exchangeAuth(session, o.identity, "nest", "perch", hello.id, th, timeoutMs);
  return { channel: session, hello };
}

/** In-memory transport pair, for tests and single-process setups. */
export function memoryTransportPair(): [FrameTransport, FrameTransport] {
  type End = { msg: Set<(d: string) => void>; close: Set<(r?: string) => void>; closed: boolean; closing: boolean };
  const a: End = { msg: new Set(), close: new Set(), closed: false, closing: false };
  const b: End = { msg: new Set(), close: new Set(), closed: false, closing: false };
  const make = (me: End, peer: End): FrameTransport => ({
    send(data) {
      if (me.closed || me.closing) return;
      queueMicrotask(() => {
        if (!peer.closed) for (const fn of peer.msg) fn(data);
      });
    },
    onMessage(fn) {
      me.msg.add(fn);
      return () => me.msg.delete(fn);
    },
    onClose(fn) {
      me.close.add(fn);
      return () => me.close.delete(fn);
    },
    // Like a WebSocket: frames sent before close() still arrive, then both ends see the close.
    close(reason) {
      if (me.closing) return;
      me.closing = true;
      queueMicrotask(() => {
        for (const end of [me, peer]) {
          if (end.closed) continue;
          end.closed = true;
          for (const fn of end.close) fn(reason);
        }
      });
    },
  });
  return [make(a, b), make(b, a)];
}
