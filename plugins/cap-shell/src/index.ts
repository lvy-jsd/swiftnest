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
import { basename, isAbsolute, resolve } from "node:path";
import { definePlugin, PathGuard, SwiftnestFailure, type Capability, type InvokeContext } from "@swiftnest/core";
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

/** Read-only programs that read file paths from their arguments. For these, a path outside the shared folders or
 * inside a protected location escalates the risk, so `cat` cannot read what cap-files would refuse. */
const FILE_READING = new Set([
  "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep",
  "file", "stat", "ls", "du", "find", "sort", "uniq", "diff", "cmp",
  "md5sum", "sha1sum", "sha256sum", "cksum", "od", "xxd", "strings", "base64", "readlink", "realpath",
]);

/** The file-like arguments of a command: every token after the program that is not a `-` flag. */
function fileArgs(tokens: string[]): string[] {
  return tokens.slice(1).filter((t) => !t.startsWith("-"));
}

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

export function classifyCommand(command: string, readOnly: readonly string[] = DEFAULT_READ_ONLY, guard?: PathGuard): { risk: Risk; reason: string } {
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, "");
  const tokens = tokenize(command);
  const program = tokens?.[0] ? basename(tokens[0]) : "";
  // A destructive program counts when it starts a command (the program, or a new command after ; & | etc.), so
  // "ls; rm -rf x" is sensitive but "cat /etc/passwd" is not — there, passwd is a file, not a program.
  const toks = tokens ?? [];
  let destructive: string | undefined;
  for (let i = 0; i < toks.length; i++) {
    const prev = i > 0 ? toks[i - 1]! : "";
    const cur = toks[i]!;
    const startsCommand = i === 0 || /[;&|\n]/.test(prev) || /^[;&|]/.test(cur);
    const name = basename(cur.replace(/^[;&|(`]+/, ""));
    if (startsCommand && DESTRUCTIVE.includes(name)) { destructive = name; break; }
  }
  if (!destructive && DESTRUCTIVE.find((d) => program.startsWith(`${d}.`))) destructive = program;
  if (destructive) return { risk: "sensitive", reason: `runs "${destructive}", which can destroy data or change the system` };
  if (!tokens || !program) return { risk: "exec", reason: "could not parse the command" };
  if (SHELL_OPERATORS.test(unquoted)) return { risk: "exec", reason: "uses shell operators (pipes, redirects, globs or substitutions)" };
  if (program === "find" && tokens.some((t) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(t))) {
    return { risk: "sensitive", reason: "find with -delete/-exec can modify files" };
  }
  if (readOnly.includes(program)) {
    // A read-only command that reads files is only "read" if every path it names is inside the shared folders and not
    // a protected location — the same rule cap-files enforces, so the two capabilities cannot disagree.
    if (guard && FILE_READING.has(program)) {
      for (const a of fileArgs(tokens)) {
        const l = guard.lexical(a);
        if (l.secret) return { risk: "sensitive", reason: `"${program} ${a}" reads a protected location (${l.path})` };
        if (!l.inside) return { risk: "exec", reason: `"${program} ${a}" reads outside the shared folders (${l.path})` };
      }
    }
    return { risk: "read", reason: `"${program}" is on the read-only list` };
  }
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

export function shellCapability(opts: { readOnly?: string[]; cwd?: string; roots?: string[]; deny?: string[] } = {}): Capability {
  const readOnly = [...DEFAULT_READ_ONLY, ...(opts.readOnly ?? [])];
  const guard = new PathGuard({ roots: opts.roots, deny: opts.deny });
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
            en: "Run a command on the device and return its output. Read-only commands such as ls, cat or df run immediately when they only touch the shared folders; anything that changes the system, or reads a protected location, waits for the owner's approval.",
            zh: "在设备上运行一条命令并返回输出。只读命令（ls、cat、df 等）在只访问共享文件夹时直接执行；会改动系统或读取受保护位置（密钥、凭据）的命令需要主人批准。",
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
      return classifyCommand(String(args.command ?? ""), readOnly, guard);
    },
    async invoke(_tool, args, ctx) {
      const command = String(args.command ?? "").trim();
      if (!command) throw new SwiftnestFailure("BAD_ARGS", "command is empty.", 'Pass a command, e.g. {"command": "ls"}.');
      const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : opts.cwd ?? homedir();
      const { risk } = classifyCommand(command, readOnly, guard);
      // Read-only commands run without a shell; anything else only gets here after approval and uses sh -c.
      const tokens = tokenize(command)!;
      {
        // Defense in depth: the classifier used a lexical check; before running, follow symlinks. A protected location
        // is refused for any risk (secrets are never read, whatever the policy says); an out-of-bounds path is refused
        // when the command was auto-allowed as a read, but an explicitly approved exec/sensitive command may run.
        const program = basename(tokens[0]!);
        if (FILE_READING.has(program)) {
          for (const a of fileArgs(tokens)) {
            const c = await guard.check(isAbsolute(a) ? a : resolve(cwd, a));
            if (c.secret) throw new SwiftnestFailure("PATH_REFUSED", `${a} is a protected location (keys, credentials or browser data).`, "Swiftnest never reads these, whatever the policy says.");
            if (!c.inside && risk === "read") throw new SwiftnestFailure("PATH_NOT_ALLOWED", `${a} is outside the folders this device shares (${guard.roots.join(", ")}).`, "Ask the owner to add the folder to the shared roots on this device.");
          }
        }
      }
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
    const cfg = ctx.config as { readOnly?: string[]; cwd?: string; roots?: string[]; deny?: string[] };
    ctx.provideCapability(shellCapability({ readOnly: cfg.readOnly, cwd: cfg.cwd, roots: cfg.roots, deny: cfg.deny }));
  },
});
