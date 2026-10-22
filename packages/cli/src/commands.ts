/** Owner commands against the running Nest (through its admin socket). */
import { createInterface } from "node:readline/promises";
import type { AuditEntry, TaskSnapshot } from "@swiftnest/protocol";
import type { PairingCandidate } from "@swiftnest/core";
import { adminCall } from "./admin.js";
import { adminSocket } from "./daemons.js";
import { t, type Lang } from "./i18n.js";

const call = <T>(method: string, params: Record<string, unknown> = {}) => adminCall<T>(adminSocket(), method, params);

/** Show a code, then confirm each device that uses it by comparing fingerprints. */
export async function pair(lang: Lang, o: { confirm?: string; reject?: string; pending?: boolean }) {
  if (o.pending) {
    const list = await call<PairingCandidate[]>("pair.pending");
    process.stdout.write((list.length ? list.map((c) => t(lang, "pairPendingRow")(c.id, c.device, c.fingerprint)).join("\n") : t(lang, "pairNoneWaiting")) + "\n");
    return;
  }
  if (o.confirm || o.reject) {
    const r = await call<{ ok: boolean }>("pair.confirm", { id: o.confirm ?? o.reject, accept: Boolean(o.confirm) });
    process.stdout.write((r.ok ? t(lang, o.confirm ? "pairOwnerYes" : "pairOwnerNo") : t(lang, "pairNoSuch")) + "\n");
    return;
  }
  const started = await call<{ code: string; expiresAt: string; fingerprint: string }>("pair.start");
  process.stdout.write(t(lang, "pairStarted")(started.code, new Date(started.expiresAt).toLocaleTimeString(), started.fingerprint));
  if (!process.stdin.isTTY) {
    process.stdout.write(t(lang, "pairHeadless") + "\n");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const seen = new Set<string>();
  const deadline = Date.parse(started.expiresAt) + 5 * 60_000;
  try {
    while (Date.now() < deadline) {
      const pending = await call<PairingCandidate[]>("pair.pending");
      const next = pending.find((c) => !seen.has(c.id));
      if (!next) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      seen.add(next.id);
      const yes = /^y(es)?$/i.test((await rl.question(t(lang, "pairConfirmPrompt")(next.device, next.fingerprint))).trim());
      await call("pair.confirm", { id: next.id, accept: yes });
      process.stdout.write((yes ? t(lang, "pairOwnerYes") : t(lang, "pairOwnerNo")) + "\n");
      if (yes) return;
    }
    process.stdout.write(t(lang, "pairExpired") + "\n");
  } finally {
    rl.close();
  }
}

export async function devices(lang: Lang) {
  const list = await call<{ device: string; publicKey: string; pairedAt: string; online: boolean; via?: string; capabilities: { id: string; tools: string[] }[] }[]>("devices");
  if (!list.length) return void process.stdout.write(t(lang, "devicesNone") + "\n");
  for (const d of list) {
    const tools = d.capabilities.flatMap((c) => c.tools.map((tool) => `${c.id}.${tool}`)).join(", ");
    process.stdout.write(t(lang, "devicesRow")(d.device, d.online, d.via, d.pairedAt.slice(0, 10), tools) + "\n");
  }
}

export async function revoke(lang: Lang, device: string | undefined) {
  if (!device) return void process.stdout.write(t(lang, "needArg")("swiftnest revoke <device>") + "\n");
  const r = await call<{ ok: boolean }>("revoke", { device });
  process.stdout.write((r.ok ? t(lang, "revoked")(device) : t(lang, "revokeUnknown")(device)) + "\n");
}

export async function pending(lang: Lang) {
  const list = await call<TaskSnapshot[]>("tasks.pending");
  if (!list.length) return void process.stdout.write(t(lang, "pendingNone") + "\n");
  for (const s of list) process.stdout.write(t(lang, "pendingRow")(s.id, s.device, `${s.capability}.${s.tool}`, JSON.stringify(s.args), s.risk, s.reason ?? "") + "\n");
}

export async function decide(lang: Lang, id: string | undefined, approve: boolean) {
  if (!id) return void process.stdout.write(t(lang, "needArg")(`swiftnest ${approve ? "approve" : "deny"} <task-id>`) + "\n");
  const s = await call<TaskSnapshot>(approve ? "tasks.approve" : "tasks.deny", { id });
  process.stdout.write(`${approve ? t(lang, "approved") : t(lang, "denied")} ${s.id} → ${s.state}\n`);
}

export async function audit(lang: Lang, limit: number, device?: string) {
  const rows = await call<AuditEntry[]>("audit.tail", { limit, device });
  if (!rows.length) return void process.stdout.write(t(lang, "auditNone") + "\n");
  for (const e of rows) {
    process.stdout.write(`${e.at}  ${e.state.padEnd(16)} ${e.device}__${e.capability}__${e.tool} ${JSON.stringify(e.args)}  ← ${e.client.name ?? e.client.id}${e.reason ? `  (${e.reason})` : ""}${e.error ? `  [${e.error.code}]` : ""}\n`);
  }
}
