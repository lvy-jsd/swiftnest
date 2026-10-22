/**
 * The two long-running programs:
 *   swiftnest nest   — the server: paired devices, policy, approvals, audit, the MCP endpoint for agents, the LAN link,
 *                      and the owner's admin socket. State in <state>/nest/.
 *   swiftnest perch  — a device: shell + files capabilities, connected to the Nest over the LAN. State in
 *                      <state>/perch/<name>/.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import files from "@swiftnest/cap-files";
import shell from "@swiftnest/cap-shell";
import { createLogger, fingerprintOf, JsonDeviceStore, JsonlAuditLog, loadOrCreateIdentity, Nest, Perch, RulePolicy, SwiftnestFailure } from "@swiftnest/core";
import { runLanPerch, serveLan, type PerchState } from "@swiftnest/link-lan";
import { serveMcpHttp } from "@swiftnest/surface-mcp";
import { adminCall, adminHandlers, serveAdmin } from "./admin.js";
import { terminalApprovals } from "./approvals.js";
import { t, type Lang } from "./i18n.js";
import { stateDir } from "./paths.js";

export const nestDir = () => join(stateDir(), "nest");
export const adminSocket = () => join(nestDir(), "nest.sock");

export interface NestRunOptions {
  lanPort: number;
  lanHost: string;
  mcpPort: number;
  mdns: boolean;
}

export async function runNest(lang: Lang, o: NestRunOptions): Promise<void> {
  const dir = nestDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // One Nest per user: a second one would fight over the socket and the paired-device file.
  if (await adminCall(adminSocket(), "status").then(() => true, () => false)) {
    throw new SwiftnestFailure("NEST_ALREADY_RUNNING", "A Nest is already running for this user.", "Use that one (`swiftnest devices`), or stop it first.");
  }
  const logger = createLogger("nest");
  const nest = new Nest({
    identity: await loadOrCreateIdentity(join(dir, "identity.pem")),
    devices: await JsonDeviceStore.open(join(dir, "devices.json")),
    audit: new JsonlAuditLog(join(dir, "audit.jsonl")),
    policy: new RulePolicy(),
    logger,
  });
  const lan = await serveLan(nest, { host: o.lanHost, port: o.lanPort, advertise: o.mdns, logger: logger.child("lan") });
  const mcp = await serveMcpHttp(nest, { port: o.mcpPort, lang });
  const admin = await serveAdmin(adminSocket(), adminHandlers(nest));
  const approvals = process.stdin.isTTY ? terminalApprovals(nest, lang) : undefined;

  process.stdout.write(t(lang, "nestReady")(nest.identity.fingerprint, lan.port, mcp.url, join(dir, "audit.jsonl"), Boolean(approvals)));

  const shutdown = async () => {
    approvals?.close();
    await admin.close();
    await lan.close();
    await mcp.close?.();
    await nest.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

export interface PerchRunOptions {
  name: string;
  nest?: string;
  pair?: string;
  /** Expected Nest fingerprint, for pairing without a terminal. */
  fingerprint?: string;
  roots: string[];
  readOnly: string[];
}

interface Pin {
  nestKey: string;
  fingerprint: string;
  url?: string;
  pairedAt: string;
}

export async function runPerch(lang: Lang, o: PerchRunOptions): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(o.name)) {
    throw new SwiftnestFailure("BAD_NAME", `"${o.name}" cannot be a device name.`, "Use lowercase letters, digits and dashes, e.g. --name laptop.");
  }
  const dir = join(stateDir(), "perch", o.name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pinPath = join(dir, "nest.json");
  let pin: Pin | undefined = await readFile(pinPath, "utf8").then((s) => JSON.parse(s) as Pin, () => undefined);
  if (!pin && !o.pair) throw new SwiftnestFailure("NOT_PAIRED", t(lang, "perchNotPaired")(o.name), t(lang, "perchNotPairedHint")(o.name));
  const savePin = async (p: Pin) => {
    pin = p;
    await writeFile(pinPath, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  };

  const logger = createLogger(`perch:${o.name}`, "warn");
  const perch = await new Perch({ device: o.name, identity: await loadOrCreateIdentity(join(dir, "identity.pem")), logger })
    .use(shell, { readOnly: o.readOnly })
    .then((p) => p.use(files, { roots: o.roots }));

  const confirm = async (nestFingerprint: string) => {
    if (o.fingerprint) {
      const same = o.fingerprint.toLowerCase() === nestFingerprint;
      process.stdout.write(t(lang, same ? "perchFpMatch" : "perchFpMismatch")(nestFingerprint) + "\n");
      return same;
    }
    if (!process.stdin.isTTY) {
      process.stdout.write(t(lang, "perchFpNoTerminal")(nestFingerprint) + "\n");
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(t(lang, "perchFpPrompt")(nestFingerprint))).trim());
    } finally {
      rl.close();
    }
  };

  process.stdout.write(t(lang, "perchStarting")(o.name, perch.identity.fingerprint, o.roots.join(", ")));
  const run = runLanPerch(perch, {
    url: o.nest,
    lastUrl: pin?.url,
    nestKey: o.pair ? undefined : pin?.nestKey,
    pairing: o.pair ? { code: o.pair, confirm } : undefined,
    onPaired: (nestKey, url) => savePin({ nestKey, fingerprint: fingerprintOf(nestKey), url, pairedAt: new Date().toISOString() }),
    onStatus: (s: PerchState, detail?: string) => {
      if (s === "online" && pin && detail && pin.url !== detail) void savePin({ ...pin, url: detail });
      if (s !== "stopped") process.stdout.write(t(lang, "perchStatus")(s, detail) + "\n");
    },
    logger,
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return process.exit(1);
    stopping = true;
    run.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const end = await run.finished;
  if (end.code === "REVOKED") await rm(pinPath, { force: true });
  await perch.close();
  process.stdout.write(t(lang, "perchFinished")(end.code, end.message) + "\n");
  process.exitCode = end.code === "DEVICE_DISCONNECTED" ? 0 : 1;
}
