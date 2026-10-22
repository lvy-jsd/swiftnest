#!/usr/bin/env node
// M1 acceptance (design §14), as a user would do it, with separate processes and real sockets:
//   a Nest and a paired LAN device; an MCP client calls laptop__shell__run("echo ok"); `rm` waits for approval;
//   a long call is cancelled on the device; everything is in the audit log; revoke disconnects the device for good.
// Usage: pnpm build && node scripts/acceptance-m1.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "plugins/surface-mcp/package.json"));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));

const bin = join(root, "packages/cli/dist/bin.js");
const base = mkdtempSync(join(tmpdir(), "swiftnest-m1-"));
const nestHome = join(base, "nest-machine");
const perchHome = join(base, "laptop");
const LAN = 17711 + Math.floor(Math.random() * 200);
const MCP = LAN + 1000;
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      ${detail}`}`);
};

const env = (home) => ({ ...process.env, SWIFTNEST_HOME: home, SWIFTNEST_LANG: "en", NO_COLOR: "1" });
const cli = (home, ...args) => spawnSync(process.execPath, [bin, ...args], { env: env(home), encoding: "utf8", timeout: 20_000 });
function daemon(home, ...args) {
  const p = spawn(process.execPath, [bin, ...args], { env: env(home), stdio: ["ignore", "pipe", "pipe"] });
  p.out = "";
  p.stdout.on("data", (d) => (p.out += d));
  p.stderr.on("data", (d) => (p.out += d));
  return p;
}
const waitFor = async (fn, ms = 15_000, label = "condition") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const nest = daemon(nestHome, "nest", "--lan-host", "127.0.0.1", "--lan-port", String(LAN), "--mcp-port", String(MCP), "--no-mdns");
let perch;
try {
  await waitFor(() => /Agents connect to: (\S+)/.exec(nest.out), 15_000, "the Nest to start");
  const nestFp = /Nest fingerprint: (\S+)/.exec(nest.out)[1];

  // --- pairing: code + fingerprints on both sides --------------------------------
  const paired = cli(nestHome, "pair");
  const code = /Pairing code: (\d{6})/.exec(paired.stdout)?.[1];
  check("swiftnest pair shows a 6-digit code and the Nest fingerprint", Boolean(code) && paired.stdout.includes(nestFp), paired.stdout + paired.stderr);

  const wrongFp = daemon(perchHome, "perch", "--name", "laptop", "--pair", code, "--nest", `ws://127.0.0.1:${LAN}/swiftnest`, "--fingerprint", "0000-0000-0000-0000");
  await new Promise((r) => wrongFp.on("exit", r));
  check("a device refuses a Nest whose fingerprint is not the expected one", /does not match --fingerprint/.test(wrongFp.out), wrongFp.out);

  const again = cli(nestHome, "pair");
  const code2 = /Pairing code: (\d{6})/.exec(again.stdout)?.[1];
  perch = daemon(perchHome, "perch", "--name", "laptop", "--pair", code2, "--nest", `ws://127.0.0.1:${LAN}/swiftnest`, "--fingerprint", nestFp, "--roots", base);
  const pendingId = await waitFor(() => /^(p\d+)\s+"laptop"/m.exec(cli(nestHome, "pair", "--pending").stdout)?.[1], 15_000, "the pairing request");
  cli(nestHome, "pair", "--confirm", pendingId);
  await waitFor(() => /● online/.test(perch.out), 15_000, "the device to come online");
  check("after both confirm, the device is online", /● laptop\s+online via lan/.test(cli(nestHome, "devices").stdout), cli(nestHome, "devices").stdout);
  check("the device saved the pinned Nest key", existsSync(join(perchHome, "perch/laptop/nest.json")));

  // --- an agent over MCP ---------------------------------------------------------------
  const client = new Client({ name: "acceptance", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP}/mcp`)));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("the agent sees laptop__shell__run and laptop__files__read", tools.includes("laptop__shell__run") && tools.includes("laptop__files__read"), tools.join(", "));
  const textOf = (r) => r.content.map((c) => c.text ?? "").join("\n");

  const echo = await client.callTool({ name: "laptop__shell__run", arguments: { command: "echo ok" } });
  check('laptop__shell__run("echo ok") answers "ok"', /\bok\b/.test(textOf(echo)) && !echo.isError, textOf(echo));

  const rm = await client.callTool({ name: "laptop__shell__run", arguments: { command: `rm -rf ${join(base, "nothing-here")}` } });
  const rmId = /(t[\w-]+)/.exec(textOf(rm))?.[1];
  check("an rm command is stopped for approval", /approval/i.test(textOf(rm)), textOf(rm));
  const listed = cli(nestHome, "pending").stdout;
  check("swiftnest pending shows it with the raw command and the risk", listed.includes("rm -rf") && /sensitive/.test(listed), listed);
  const taskId = /^(\S+)\s+laptop shell\.run/m.exec(listed)?.[1];
  cli(nestHome, "deny", taskId);
  const st = await client.callTool({ name: "swiftnest__task_status", arguments: { task_id: taskId } });
  check("swiftnest deny refuses it", /denied/.test(textOf(st)), textOf(st));

  const sleeper = await client.callTool({ name: "laptop__shell__run", arguments: { command: "sleep 30; echo late" } });
  const sleepId = /^(\S+)\s+laptop shell\.run/m.exec(cli(nestHome, "pending").stdout)?.[1];
  cli(nestHome, "approve", sleepId);
  await waitFor(async () => /running/.test(textOf(await client.callTool({ name: "swiftnest__task_status", arguments: { task_id: sleepId } }))), 5_000, "the long call to run");
  const t0 = Date.now();
  await client.callTool({ name: "swiftnest__task_cancel", arguments: { task_id: sleepId } });
  let lastStatus = "";
  const cancelled = await waitFor(async () => {
    const res = await client.callTool({ name: "swiftnest__task_status", arguments: { task_id: sleepId } });
    lastStatus = `${res.structuredContent?.state}: ${textOf(res)}`;
    return res.structuredContent?.state === "cancelled" && lastStatus;
  }, 5_000, "the cancel").catch((e) => {
    throw new Error(`${e.message}; last status: ${lastStatus}`);
  });
  check("a running 30-second call is cancelled on the device within seconds", Date.now() - t0 < 5_000 && !/late/.test(cancelled), cancelled);
  await new Promise((r) => setTimeout(r, 300));
  const left = spawnSync("pgrep", ["-af", "^/bin/sh -c sleep 30; echo late"]).stdout.toString().trim();
  check("…and its process is really gone", !left, left);
  void sleeper, rmId;

  const audit = cli(nestHome, "audit", "-n", "50").stdout;
  check("the audit log has the echo, the denied rm and the cancelled sleep", /succeeded\s+laptop__shell__run \{"command":"echo ok"\}/.test(audit) && /denied\s+laptop__shell__run .*rm -rf/.test(audit) && /cancelled\s+laptop__shell__run .*sleep 30/.test(audit), audit);
  await client.close();

  // --- revoke ------------------------------------------------------------------------------
  cli(nestHome, "revoke", "laptop");
  await waitFor(() => perch.exitCode !== null, 10_000, "the device to exit");
  check("revoke disconnects the device for good and it deletes its pairing", /revoked on the Nest/.test(perch.out) && !existsSync(join(perchHome, "perch/laptop/nest.json")), perch.out);
  check("a revoked device cannot reconnect", /not paired/i.test(cli(perchHome, "perch", "--name", "laptop").stderr));
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}\n--- nest output\n${nest.out}\n--- device output\n${perch?.out ?? ""}`);
} finally {
  perch?.kill();
  nest.kill();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
