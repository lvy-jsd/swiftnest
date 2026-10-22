/**
 * @swiftnest/cap-shell — run commands on the device.
 *
 * Argument-level risk (design §7.3):
 *  - read: a known read-only program and no shell operators → allowed by default, executed WITHOUT a shell
 *          (no injection possible through arguments);
 *  - sensitive: destructive or privilege-changing programs (rm, dd, mkfs, shutdown, sudo, kill, chmod…) → a person decides;
 *  - exec: everything else → asks by default. Approved non-read commands run through `sh -c`.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { definePlugin, SwiftnestFailure, type Capability, type InvokeContext } from "@swiftnest/core";
import type { Risk } from "@swiftnest/protocol";

export const DEFAULT_READ_ONLY = [
  "echo", "pwd", "whoami", "id", "hostname", "uname", "date", "uptime", "ls", "cat", "head", "tail", "wc",
  "df", "du", "free", "ps", "which", "file", "stat", "grep", "sort", "uniq", "true", "nproc", "lscpu",
];
export const DESTRUCTIVE = [
  "rm", "rmdir", "dd", "shred", "mkfs", "fdisk", "parted", "wipefs", "shutdown", "reboot", "poweroff", "halt",
  "kill", "killall", "pkill", "sudo", "su", "doas", "chmod", "chown", "chattr", "mount", "umount", "iptables",
  "nft", "systemctl", "crontab", "passwd", "useradd", "userdel",
];
const SHELL_OPERATORS = /[;&|`$<>(){}\n\\*?~]/;
const MAX_OUTPUT = 64 * 1024;

/** Split a command line on whitespace, honouring simple single/double quotes. Returns null on unbalanced quotes. */
export function tokenize(command: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let had = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      had = true;
    } else if (/\s/.test(ch)) {
      if (cur || had) out.push(cur);
      cur = "";
      had = false;
    } else cur += ch;
  }
  if (quote) return null;
  if (cur || had) out.push(cur);
  return out;
}

export function classifyCommand(command: string, readOnly: readonly string[] = DEFAULT_READ_ONLY): { risk: Risk; reason: string } {
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, "");
  const tokens = tokenize(command);
  const program = tokens?.[0] ? basename(tokens[0]) : "";
  // Any word naming a destructive program counts (covers "ls; rm -rf x"); prefix forms like mkfs.ext4 only as the program.
  const words = (tokens ?? command.split(/\s+/)).map((t) => basename(t.replace(/^[;&|(`]+/, "")));
  const destructive =
    words.find((w) => DESTRUCTIVE.includes(w)) ?? (DESTRUCTIVE.find((d) => program.startsWith(`${d}.`)) ? program : undefined);
  if (destructive) return { risk: "sensitive", reason: `runs "${destructive}", which can destroy data or change the system` };
  if (!tokens || !program) return { risk: "exec", reason: "could not parse the command" };
  if (SHELL_OPERATORS.test(unquoted)) return { risk: "exec", reason: "uses shell operators (pipes, redirects, globs or substitutions)" };
  if (program === "find" && tokens.some((t) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(t))) {
    return { risk: "sensitive", reason: "find with -delete/-exec can modify files" };
  }
  if (readOnly.includes(program)) return { risk: "read", reason: `"${program}" is on the read-only list` };
  return { risk: "exec", reason: `"${program}" is not on the read-only list` };
}

function run(file: string, args: string[], cwd: string, ctx: InvokeContext) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }>((resolve, reject) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const take = (buf: Buffer, which: "out" | "err") => {
      const s = buf.toString("utf8");
      if (stdout.length + stderr.length + s.length > MAX_OUTPUT) truncated = true;
      if (truncated) return;
      if (which === "out") stdout += s;
      else stderr += s;
    };
    child.stdout.on("data", (b: Buffer) => take(b, "out"));
    child.stderr.on("data", (b: Buffer) => take(b, "err"));
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL"); // whole process group
      } catch {
        child.kill("SIGKILL");
      }
    };
    ctx.signal.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      ctx.signal.removeEventListener("abort", kill);
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new SwiftnestFailure("COMMAND_NOT_FOUND", `"${file}" was not found on this device.`, "Check the program name, or install it on the device.")
          : e,
      );
    });
    child.on("close", (code) => {
      ctx.signal.removeEventListener("abort", kill);
      resolve({ exitCode: code, stdout, stderr, truncated });
    });
  });
}

export function shellCapability(opts: { readOnly?: string[]; cwd?: string } = {}): Capability {
  const readOnly = [...DEFAULT_READ_ONLY, ...(opts.readOnly ?? [])];
  return {
    manifest: {
      id: "shell",
      version: "0.0.1",
      title: { en: "Shell", zh: "命令行" },
      description: { en: "Run commands on this device.", zh: "在这台设备上运行命令。" },
      permissions: ["process.spawn"],
      tools: [
        {
          name: "run",
          title: { en: "Run a command", zh: "运行命令" },
          description: {
            en: "Run a command on the device and return its output. Read-only commands such as ls, cat or df run immediately; anything that changes the system waits for the owner's approval.",
            zh: "在设备上运行一条命令并返回输出。ls、cat、df 等只读命令直接执行；会改动系统的命令需要主人批准。",
          },
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command line, e.g. \"ls -la /tmp\" (read-only commands without shell operators run immediately)" },
              cwd: { type: "string", description: "Working directory (default: the user's home)" },
            },
            required: ["command"],
            additionalProperties: false,
          },
          risk: "exec",
          defaultTimeoutMs: 60_000,
        },
      ],
    },
    classify(_tool, args) {
      return classifyCommand(String(args.command ?? ""), readOnly);
    },
    async invoke(_tool, args, ctx) {
      const command = String(args.command ?? "").trim();
      if (!command) throw new SwiftnestFailure("BAD_ARGS", "command is empty.", 'Pass a command, e.g. {"command": "ls"}.');
      const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : opts.cwd ?? homedir();
      const { risk } = classifyCommand(command, readOnly);
      // Read-only commands run without a shell; anything else only gets here after approval and uses sh -c.
      const tokens = tokenize(command)!;
      const r = risk === "read" ? await run(tokens[0]!, tokens.slice(1), cwd, ctx) : await run("/bin/sh", ["-c", command], cwd, ctx);
      const parts = [r.stdout.trimEnd()];
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
      if (r.exitCode !== 0) parts.push(`[exit code ${r.exitCode}]`);
      if (r.truncated) parts.push(`[output truncated at ${MAX_OUTPUT} bytes]`);
      return { text: parts.filter(Boolean).join("\n"), data: r };
    },
  };
}

export default definePlugin({
  name: "@swiftnest/cap-shell",
  kind: "capability",
  apiVersion: 1,
  runsOn: "perch",
  setup(ctx) {
    if (ctx.role !== "perch") return;
    const cfg = ctx.config as { readOnly?: string[]; cwd?: string };
    ctx.provideCapability(shellCapability({ readOnly: cfg.readOnly, cwd: cfg.cwd }));
  },
});
