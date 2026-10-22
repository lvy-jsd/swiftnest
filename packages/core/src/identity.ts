/**
 * Device identity: one Ed25519 key pair per Nest / Perch, using Node's built-in crypto (no native or third-party deps).
 * The short fingerprint is what users compare on both screens during pairing.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Identity {
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  /** "ab12-cd34-ef56-7890": first 8 bytes of SHA-256(publicKey), for humans to compare. */
  fingerprint: string;
  sign(data: Uint8Array | string): string;
}

const RAW_PREFIX_LEN = 12; // SPKI DER prefix length for Ed25519

export function rawPublicKey(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(RAW_PREFIX_LEN)).toString("base64url");
}

export function fingerprintOf(publicKey: string): string {
  const hex = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g)!.join("-");
}

function fromPrivateKey(privateKey: KeyObject): Identity {
  const publicKey = rawPublicKey(createPublicKey(privateKey));
  return {
    publicKey,
    fingerprint: fingerprintOf(publicKey),
    sign: (data) => sign(null, typeof data === "string" ? Buffer.from(data) : data, privateKey).toString("base64url"),
  };
}

export function generateIdentity(): Identity {
  return fromPrivateKey(generateKeyPairSync("ed25519").privateKey);
}

/** Load the identity stored at `path` (PEM, mode 600), creating it on first use. */
export async function loadOrCreateIdentity(path: string): Promise<Identity> {
  try {
    return fromPrivateKey(createPrivateKey(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return fromPrivateKey(privateKey);
}

export function verifySignature(publicKey: string, data: Uint8Array | string, signature: string): boolean {
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), // Ed25519 SPKI prefix
    Buffer.from(publicKey, "base64url"),
  ]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, typeof data === "string" ? Buffer.from(data) : data, key, Buffer.from(signature, "base64url"));
}
