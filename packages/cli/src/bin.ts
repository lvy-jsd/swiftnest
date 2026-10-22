#!/usr/bin/env node
/** swiftnest command line: nest, perch, pair and the other owner commands, playground, doctor, version. */
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import shell from "@swiftnest/cap-shell";
import { createLogger, JsonlAuditLog, memoryLink, Nest, Perch, RulePolicy, SwiftnestFailure } from "@swiftnest/core";
import { serveMcpHttp, serveMcpStdio } from "@swiftnest/surface-mcp";
import { terminalApprovals } from "./approvals.js";
import * as owner from "./commands.js";
import { runNest, runPerch } from "./daemons.js";
import { detectLang, t, type Lang } from "./i18n.js";
import { stateDir } from "./paths.js";

export { stateDir } from "./paths.js";

const VERSION = "0.0.1";

async function playground(lang: Lang, o: { port: number; devices: string[]; stdio: boolean }) {
  const logger = createLogger("playground", o.stdio ? "warn" : "info");
  const auditPath = join(stateDir(), "playground", "audit.jsonl");
  const nest = new Nest({ audit: new JsonlAuditLog(auditPath), policy: new RulePolicy(), logger, approvalTimeoutMs: o.stdio ? 30_000 : 600_000 });
  const perches: Perch[] = [];
  for (const name of o.devices) {
    const perch = await new Perch({ device: name, logger: logger.child(name) }).use(shell);
    perches.push(perch);
    nest.attach(memoryLink(perch));
  }
  const shutdown = async () => {
    await nest.close();
    for (const p of perches) await p.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (o.stdio) {
    process.stderr.write(t(lang, "stdioNoApproval") + "\n");
    await serveMcpStdio(nest, { lang });
    return;
  }

  const http = await serveMcpHttp(nest, { port: o.port, lang });
  process.stdout.write(t(lang, "playgroundReady")(http.url, o.devices.join(", ")).replace("%AUDIT%", auditPath));

  // Approvals happen here, in the owner's terminal — never through the agent.
  terminalApprovals(nest, lang);
}

async function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = createServer().once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function doctor(lang: Lang, port: number) {
  let problems = 0;
  const ok = (m: string) => process.stdout.write(`  ✓ ${m}\n`);
  const bad = (m: string) => {
    problems++;
    process.stdout.write(`  ✗ ${m}\n`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  major >= 24 ? ok(t(lang, "doctorNodeOk")(process.versions.node)) : bad(t(lang, "doctorNode")(process.versions.node));
  ["linux", "darwin"].includes(process.platform) ? ok(t(lang, "doctorPlatformOk")(process.platform)) : bad(t(lang, "doctorPlatform")(process.platform));
  const dir = stateDir();
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    ok(t(lang, "doctorStateOk")(dir));
  } catch {
    bad(t(lang, "doctorState")(dir));
  }
  (await portFree(port)) ? ok(t(lang, "doctorPortOk")(port)) : bad(t(lang, "doctorPort")(port));
  process.stdout.write(t(lang, "doctorSummary")(problems) + "\n");
  return problems ? 1 : 0;
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      lang: { type: "string" },
      port: { type: "string", default: "7710" },
      devices: { type: "string", default: "sim" },
      stdio: { type: "boolean", default: false },
      // nest
      "lan-port": { type: "string", default: "7711" },
      "lan-host": { type: "string", default: "0.0.0.0" },
      "mcp-port": { type: "string", default: "7710" },
      "no-mdns": { type: "boolean", default: false },
      // perch
      name: { type: "string" },
      nest: { type: "string" },
      pair: { type: "string" },
      fingerprint: { type: "string" },
      roots: { type: "string", default: "~" },
      "read-only": { type: "string", default: "" },
      // owner commands
      confirm: { type: "string" },
      reject: { type: "string" },
      pending: { type: "boolean", default: false },
      device: { type: "string" },
      n: { type: "string", short: "n", default: "20" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const lang = detectLang(values.lang);
  const cmd = values.help ? "help" : (positionals[0] ?? "help");
  const list = (v: string | undefined) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const port = Number(values.port);
  switch (cmd) {
    case "nest":
      return runNest(lang, { lanPort: Number(values["lan-port"]), lanHost: String(values["lan-host"]), mcpPort: Number(values["mcp-port"]), mdns: !values["no-mdns"] });
    case "perch":
      if (!values.name) return void process.stderr.write(t(lang, "needArg")("swiftnest perch --name <device> [--pair <code>]") + "\n");
      return runPerch(lang, { name: values.name, nest: values.nest, pair: values.pair, fingerprint: values.fingerprint, roots: list(values.roots), readOnly: list(values["read-only"]) });
    case "pair":
      return owner.pair(lang, { confirm: values.confirm, reject: values.reject, pending: values.pending });
    case "devices":
      return owner.devices(lang);
    case "revoke":
      return owner.revoke(lang, positionals[1]);
    case "pending":
      return owner.pending(lang);
    case "approve":
    case "deny":
      return owner.decide(lang, positionals[1], cmd === "approve");
    case "audit":
      return owner.audit(lang, Number(values.n), values.device);
    case "playground":
      return playground(lang, { port, devices: list(values.devices), stdio: Boolean(values.stdio) });
    case "doctor":
      process.exitCode = await doctor(lang, port);
      return;
    case "version":
    case "--version":
      process.stdout.write(`swiftnest ${VERSION}\n`);
      return;
    case "help":
      process.stdout.write(t(lang, "usage"));
      return;
    default:
      process.stderr.write(t(lang, "unknownCommand")(cmd) + "\n");
      process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  // Every failure a person can hit says what went wrong and what to do next.
  const err = SwiftnestFailure.from(e, "FAILED");
  process.stderr.write(`✗ ${err.message}${err.suggestion ? `\n  → ${err.suggestion}` : ""}\n`);
  process.exitCode = 1;
}
