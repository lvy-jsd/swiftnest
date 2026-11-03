/**
 * @swiftnest/cap-shell — run commands on the device.
 *
 * Argument-level risk (design §7.3):
 *  - read: a known read-only program and no shell operators → allowed by default, executed WITHOUT a shell
 *          (no injection possible through arguments);
 *  - sensitive: destructive or privilege-changing programs (rm, dd, mkfs, shutdown, sudo, kill, chmod…) → a person decides;
 *  - exec: everything else → asks by default. Approved non-read commands run through `sh -c`.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { definePlugin, PathGuard, SwiftnestFailure, text, type Capability, type InvokeContext } from '@swiftnest/core';
import type { Risk } from '@swiftnest/protocol';
import rules from './shell-rules.json' with { type: 'json' };

/** What makes an otherwise read-only program write: flags that write, and limits on its positional arguments. */
interface WritingRule {
  shortFlags?: string;
  longFlags?: string[];
  valueFlags?: string[];
  maxPositionals?: number;
  positionalPrefix?: string;
  reason: string;
}
const RULES: {
  readOnly: string[];
  destructive: string[];
  fileReading: string[];
  shellOperators: string;
  findWrites: string[];
  writingInvocations: Record<string, WritingRule>;
} = rules;

export const DEFAULT_READ_ONLY: readonly string[] = RULES.readOnly;
export const DESTRUCTIVE: readonly string[] = RULES.destructive;
const FILE_READING = new Set(RULES.fileReading);
const MAX_OUTPUT = 64 * 1024;

/** The file-like arguments of a command: every token after the program that is not a `-` flag. */
function fileArgs(tokens: string[]): string[] {
  return tokens.slice(1).filter((t) => !t.startsWith('-'));
}

/** Positional arguments, skipping the value that follows each flag in `valueFlags`. */
function positionals(args: string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) i++;
    else if (!a.startsWith('-') || a === '-') out.push(a);
  }
  return out;
}

/**
 * Why this invocation of a read-only program writes files, runs programs or changes the system, or undefined when it
 * only reads. Reads run WITHOUT a sandbox, so a miss here is an unapproved write: doubtful cases count as writes.
 */
export function writingInvocation(program: string, args: string[]): string | undefined {
  const rule = RULES.writingInvocations[program];
  if (!rule) return undefined;
  // Short-flag clusters (`-ro`) are split by the program, so a letter anywhere in the cluster counts.
  const shortFlag = (a: string) => /^-[^-]/.test(a) && [...(rule.shortFlags ?? '')].some((f) => a.slice(1).includes(f));
  const longFlag = (a: string) => (rule.longFlags ?? []).some((n) => a === n || a.startsWith(`${n}=`));
  const rest = positionals(args, rule.valueFlags ?? []);
  const writes =
    args.some((a) => shortFlag(a) || longFlag(a)) ||
    rest.length > (rule.maxPositionals ?? Infinity) ||
    (rule.positionalPrefix !== undefined && rest.some((a) => !a.startsWith(rule.positionalPrefix!)));
  return writes ? rule.reason : undefined;
}

/** Split a command line on whitespace, honouring simple single/double quotes. Returns null on unbalanced quotes. */
export function tokenize(command: string): string[] | null {
  const out: string[] = [];
  let cur = '';
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
      cur = '';
      had = false;
    } else cur += ch;
  }
  if (quote) return null;
  if (cur || had) out.push(cur);
  return out;
}

export function classifyCommand(
  command: string,
  readOnly: readonly string[] = DEFAULT_READ_ONLY,
  guard?: PathGuard,
): { risk: Risk; reason: string } {
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, '');
  const tokens = tokenize(command);
  const program = tokens?.[0] ? basename(tokens[0]) : '';
  // A destructive program counts when it starts a command (the program, or a new command after ; & | etc.), so
  // "ls; rm -rf x" is sensitive but "cat /etc/passwd" is not — there, passwd is a file, not a program.
  const toks = tokens ?? [];
  let destructive: string | undefined;
  for (let i = 0; i < toks.length; i++) {
    const prev = i > 0 ? toks[i - 1]! : '';
    const cur = toks[i]!;
    const startsCommand = i === 0 || /[;&|\n]/.test(prev) || /^[;&|]/.test(cur);
    const name = basename(cur.replace(/^[;&|(`]+/, ''));
    if (startsCommand && DESTRUCTIVE.includes(name)) {
      destructive = name;
      break;
    }
  }
  if (!destructive && DESTRUCTIVE.find((d) => program.startsWith(`${d}.`))) destructive = program;
  if (destructive)
    return { risk: 'sensitive', reason: `runs "${destructive}", which can destroy data or change the system` };
  if (!tokens || !program) return { risk: 'exec', reason: 'could not parse the command' };
  if ([...RULES.shellOperators].some((op) => unquoted.includes(op)))
    return { risk: 'exec', reason: 'uses shell operators (pipes, redirects, globs or substitutions)' };
  if (program === 'find' && tokens.some((t) => RULES.findWrites.includes(t))) {
    return { risk: 'sensitive', reason: 'find with -delete/-exec/-fprint can modify files' };
  }
  if (readOnly.includes(program)) {
    const writes = writingInvocation(program, tokens.slice(1));
    if (writes) return { risk: 'exec', reason: writes };
    // A read-only command that reads files is only "read" if every path it names is inside the shared folders and not
    // a protected location — the same rule cap-files enforces, so the two capabilities cannot disagree.
    if (guard && FILE_READING.has(program)) {
      for (const a of fileArgs(tokens)) {
        const l = guard.lexical(a);
        if (l.secret) return { risk: 'sensitive', reason: `"${program} ${a}" reads a protected location (${l.path})` };
        if (!l.inside)
          return { risk: 'exec', reason: `"${program} ${a}" reads outside the shared folders (${l.path})` };
      }
    }
    return { risk: 'read', reason: `"${program}" is on the read-only list` };
  }
  return { risk: 'exec', reason: `"${program}" is not on the read-only list` };
}

function run(file: string, args: string[], cwd: string, ctx: InvokeContext) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }>(
    (resolve, reject) => {
      const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const take = (buf: Buffer, which: 'out' | 'err') => {
        const s = buf.toString('utf8');
        if (stdout.length + stderr.length + s.length > MAX_OUTPUT) truncated = true;
        if (truncated) return;
        if (which === 'out') stdout += s;
        else stderr += s;
      };
      child.stdout.on('data', (b: Buffer) => take(b, 'out'));
      child.stderr.on('data', (b: Buffer) => take(b, 'err'));
      const kill = () => {
        try {
          process.kill(-child.pid!, 'SIGKILL'); // whole process group
        } catch {
          child.kill('SIGKILL');
        }
      };
      ctx.signal.addEventListener('abort', kill, { once: true });
      child.on('error', (e) => {
        ctx.signal.removeEventListener('abort', kill);
        reject(
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? new SwiftnestFailure('COMMAND_NOT_FOUND', text('notFoundDevice', file), text('hintCheckProgramName'))
            : e,
        );
      });
      child.on('close', (code) => {
        ctx.signal.removeEventListener('abort', kill);
        resolve({ exitCode: code, stdout, stderr, truncated });
      });
    },
  );
}

export function shellCapability(
  opts: { readOnly?: string[]; cwd?: string; roots?: string[]; deny?: string[] } = {},
): Capability {
  const readOnly = [...DEFAULT_READ_ONLY, ...(opts.readOnly ?? [])];
  const guard = new PathGuard({ roots: opts.roots, deny: opts.deny });
  return {
    manifest: {
      id: 'shell',
      version: '0.0.1',
      title: { en: 'Shell', zh: '命令行' },
      description: { en: 'Run commands on this device.', zh: '在这台设备上运行命令。' },
      permissions: ['process.spawn'],
      tools: [
        {
          name: 'run',
          title: { en: 'Run a command', zh: '运行命令' },
          description: {
            en: "Run a command on the device and return its output. Read-only commands such as ls, cat or df run immediately when they only touch the shared folders; anything that changes the system, or reads a protected location, waits for the owner's approval.",
            zh: '在设备上运行一条命令并返回输出。只读命令（ls、cat、df 等）在只访问共享文件夹时直接执行；会改动系统或读取受保护位置（密钥、凭据）的命令需要主人批准。',
          },
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description:
                  'The command line, e.g. "ls -la /tmp" (read-only commands without shell operators run immediately)',
              },
              cwd: { type: 'string', description: "Working directory (default: the user's home)" },
            },
            required: ['command'],
            additionalProperties: false,
          },
          risk: 'exec',
          defaultTimeoutMs: 60_000,
        },
      ],
    },
    classify(_tool, args) {
      return classifyCommand(String(args.command ?? ''), readOnly, guard);
    },
    async invoke(_tool, args, ctx) {
      const command = String(args.command ?? '').trim();
      if (!command) throw new SwiftnestFailure('BAD_ARGS', text('commandEmpty'), text('hintPassCommand'));
      const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : (opts.cwd ?? homedir());
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
            if (c.secret)
              throw new SwiftnestFailure(
                'PATH_REFUSED',
                text('protectedLocationKeysCredentialsBrowserData', a),
                text('hintNeverReadsSecrets'),
              );
            if (!c.inside && risk === 'read')
              throw new SwiftnestFailure(
                'PATH_NOT_ALLOWED',
                text('outsideFoldersDeviceShares', a, guard.roots.join(', ')),
                text('hintAskOwnerToShareRoot'),
              );
          }
        }
      }
      const r =
        risk === 'read'
          ? await run(tokens[0]!, tokens.slice(1), cwd, ctx)
          : await run('/bin/sh', ['-c', command], cwd, ctx);
      const parts = [r.stdout.trimEnd()];
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
      if (r.exitCode !== 0) parts.push(`[exit code ${r.exitCode}]`);
      if (r.truncated) parts.push(`[output truncated at ${MAX_OUTPUT} bytes]`);
      return { text: parts.filter(Boolean).join('\n'), data: r };
    },
  };
}

export default definePlugin({
  name: '@swiftnest/cap-shell',
  kind: 'capability',
  apiVersion: 1,
  runsOn: 'perch',
  setup(ctx) {
    if (ctx.role !== 'perch') return;
    const cfg = ctx.config as { readOnly?: string[]; cwd?: string; roots?: string[]; deny?: string[] };
    ctx.provideCapability(shellCapability({ readOnly: cfg.readOnly, cwd: cfg.cwd, roots: cfg.roots, deny: cfg.deny }));
  },
});
