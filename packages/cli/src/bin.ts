#!/usr/bin/env node
/** swiftnest command line: playground, doctor, version. */
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import shell from "@swiftnest/cap-shell";
import { createLogger, JsonlAuditLog, memoryLink, Nest, Perch, RulePolicy } from "@swiftnest/core";
import { serveMcpHttp, serveMcpStdio } from "@swiftnest/surface-mcp";
import { detectLang, t, type Lang } from "./i18n.js";

const VERSION = "0.0.1";

export function stateDir(): string {
  return process.env.SWIFTNEST_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "swiftnest");
}

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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let terminalOpen = true;
  rl.on("close", () => {
    terminalOpen = false;
  });
  let queue = Promise.resolve();
  nest.tasks.onChange((s) => {
    if (s.state !== "pending_approval") return;
    queue = queue.then(async () => {
      const current = nest.tasks.get(s.id);
      if (current?.state !== "pending_approval") return;
      const prompt = t(lang, "approvalPrompt")(s.client.name ?? s.client.id, s.device, `${s.capability}.${s.tool}`, JSON.stringify(s.args), s.risk, s.reason ?? "");
      if (!terminalOpen) {
        // No terminal to ask in (running in the background or under a service manager): show it, leave it pending.
        process.stdout.write(prompt + "\n" + t(lang, "noTerminal") + "\n");
        return;
      }
      let answer = "";
      try {
        answer = await rl.question(prompt);
      } catch {
        process.stdout.write("\n" + t(lang, "noTerminal") + "\n");
        return;
      }
      if (/^y(es)?$/i.test(answer.trim())) {
        await nest.tasks.approve(s.id, "terminal");
        process.stdout.write(t(lang, "approved") + "\n");
      } else {
        await nest.tasks.deny(s.id, "denied in terminal");
        process.stdout.write(t(lang, "denied") + "\n");
      }
    });
  });
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const lang = detectLang(values.lang);
  const cmd = positionals[0] ?? (values.help ? "help" : "help");
  const port = Number(values.port);
  switch (cmd) {
    case "playground":
      return playground(lang, { port, devices: String(values.devices).split(",").map((d) => d.trim()).filter(Boolean), stdio: Boolean(values.stdio) });
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

await main(process.argv.slice(2));
