/**
 * Shared path guard: the single source of truth for "which folders does this device share, and which locations are
 * never touched". cap-files enforces it on every call; cap-shell uses it to decide whether a read-only command
 * (cat, head, grep…) may run without asking, so the two capabilities cannot disagree about a secret or an
 * out-of-bounds path. A read-only `cat` must not be able to read what cap-files would refuse.
 *
 * Every path is resolved to its real location (symlinks followed) before it is checked, so a link cannot lead out
 * of an allowed folder.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Relative to the home directory. A path equal to or under one of these is never touched. */
export const SECRET_PATHS = [
  ".ssh", ".gnupg", ".password-store", ".netrc", ".pgpass", ".git-credentials",
  ".aws", ".azure", ".config/gcloud", ".kube", ".docker/config.json",
  ".npmrc", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".config/gh",
  ".local/share/keyrings", ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware",
  ".local/state/swiftnest", ".config/swiftnest",
];

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** True when `child` is `parent` or lives under it. */
export function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Real path of `p`, or of its nearest existing ancestor joined with the rest (for files about to be created). */
export async function realish(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(p);
    if (parent === p) return p;
    return join(await realish(parent), basename(p));
  }
}

export interface PathGuardOptions {
  /** Allowed folders (default: the home directory). `~` is expanded. */
  roots?: string[];
  /** More paths to refuse, absolute or `~/…`. */
  deny?: string[];
}

export interface LexicalCheck {
  /** The resolved lexical path (no symlinks followed). */
  path: string;
  /** Inside one of the allowed roots. */
  inside: boolean;
  /** Inside a protected (secret) location. */
  secret: boolean;
}

export interface RealCheck extends LexicalCheck {
  /** The real path, symlinks followed. */
  real: string;
}

export class PathGuard {
  readonly roots: string[];
  readonly secrets: string[];
  private realRootsCache?: Promise<string[]>;
  private realSecretsCache?: Promise<string[]>;

  constructor(opts: PathGuardOptions = {}) {
    this.roots = (opts.roots?.length ? opts.roots : ["~"]).map((r) => resolve(expandHome(r)));
    this.secrets = [
      ...SECRET_PATHS.map((s) => join(homedir(), s)),
      ...(opts.deny ?? []).map((d) => resolve(expandHome(d))),
    ];
    if (process.env.SWIFTNEST_HOME) this.secrets.push(resolve(process.env.SWIFTNEST_HOME));
  }

  /** Lexical check (no I/O), used for risk classification before anything runs. */
  lexical(raw: string): LexicalCheck {
    const given = expandHome(raw);
    const path = isAbsolute(given) ? resolve(given) : resolve(this.roots[0]!, given);
    return { path, inside: this.roots.some((r) => within(path, r)), secret: this.secrets.some((s) => within(path, s)) };
  }

  /** The real check (follows symlinks), right before acting. */
  async check(raw: string): Promise<RealCheck> {
    const { path } = this.lexical(raw);
    const real = await realish(path);
    const inside = (await this.realRoots()).some((r) => within(real, r));
    const secret = (await this.realSecrets()).some((s) => within(real, s)) || this.secrets.some((s) => within(path, s));
    return { path, real, inside, secret };
  }

  /** The real (symlink-resolved) allowed roots. */
  async realRoots(): Promise<string[]> {
    this.realRootsCache ??= Promise.all(this.roots.map((r) => realish(r)));
    return this.realRootsCache;
  }

  private async realSecrets(): Promise<string[]> {
    this.realSecretsCache ??= Promise.all(this.secrets.map((s) => realish(s)));
    return this.realSecretsCache;
  }
}