/**
 * Runs the pinned DSH kernel as a child process on the `swiftnest` profile and
 * reports the URL it serves. A child process keeps DSH's own lifecycle,
 * reload and crash handling intact, and lets the kernel use the official Node
 * build its native addon needs (see docs/en/dev/dsh-integration.md).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerConfig } from "./config.js";
import { PROFILE_NAME, dshHome, profileDir, writeProfile } from "./profile.js";

const require = createRequire(import.meta.url);

export interface KernelPaths {
  dshBin: string;
  dshVersion: string;
  bundleDir: string;
  swiftnestVersion: string;
}

export function resolveKernel(): KernelPaths {
  const dshPkg = require.resolve("@deepseek-ai/dsh/package.json");
  const bundlePkg = require.resolve("@swiftnest/server-bundle/package.json");
  const ownPkg = require.resolve("../package.json");
  return {
    swiftnestVersion: (JSON.parse(readFileSync(ownPkg, "utf8")) as { version: string }).version,
    dshBin: join(dirname(dshPkg), "lib", "bin.js"),
    dshVersion: (JSON.parse(readFileSync(dshPkg, "utf8")) as { version: string }).version,
    bundleDir: dirname(bundlePkg),
  };
}

export interface RunningKernel {
  /** Root URL the kernel serves, without the launch token. */
  url: string;
  /** Per-process launch token; trades for a session cookie at `/` or `/connect`. */
  token: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Node executable for the kernel; defaults to $SWIFTNEST_KERNEL_NODE, then the one running Swiftnest. */
  node?: string;
  /** Extra environment for the kernel (API keys, proxies). */
  env?: NodeJS.ProcessEnv;
  /** Receives every kernel output line. */
  onLine?: (line: string) => void;
  readyTimeoutMs?: number;
}

/** `dsh web: http://127.0.0.1:3077/?token=…` */
const READY_LINE = /dsh web:\s*(\S+)/;

export function parseReadyLine(line: string): { url: string; token: string } | undefined {
  const match = READY_LINE.exec(line);
  if (!match?.[1]) return undefined;
  const full = new URL(match[1]);
  const token = full.searchParams.get("token");
  if (!token) return undefined;
  full.search = "";
  return { url: full.toString(), token };
}

export async function startKernel(config: ServerConfig, opts: StartOptions = {}): Promise<RunningKernel> {
  const paths = resolveKernel();
  writeProfile(config, { bundleDir: paths.bundleDir });
  const args = [
    paths.dshBin,
    "--profile",
    PROFILE_NAME,
    "--patch",
    join(profileDir(config), "user.patch.yml"),
    "--no-open",
    "--host",
    config.host,
    "--port",
    String(config.port),
  ];
  const child = spawn(opts.node ?? process.env.SWIFTNEST_KERNEL_NODE ?? process.execPath, args, {
    cwd: config.home,
    env: {
      ...process.env,
      ...opts.env,
      DSH_HOME: dshHome(config),
      SWIFTNEST_VERSION: paths.swiftnestVersion,
      SWIFTNEST_DSH_VERSION: paths.dshVersion,
      SWIFTNEST_MODEL_BASE_URL: config.model.baseUrl,
      [config.model.apiKeyEnv]: opts.env?.[config.model.apiKeyEnv] ?? process.env[config.model.apiKeyEnv] ?? "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = () =>
    new Promise<void>((resolveStop) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveStop();
      child.once("exit", () => resolveStop());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    });

  return new Promise<RunningKernel>((resolveStart, rejectStart) => {
    let settled = false;
    const tail: string[] = [];
    const timer = setTimeout(() => fail(new Error("DSH kernel did not report ready in time")), opts.readyTimeoutMs ?? 60_000);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stop();
      const hint = tail.some((l) => l.includes("node-addon-require-builtin"))
        ? "\nHint: DSH needs Node from nodejs.org; point SWIFTNEST_KERNEL_NODE at that node binary."
        : "";
      rejectStart(new Error(`${err.message}${hint}\n--- kernel output ---\n${tail.join("\n")}`));
    };
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        opts.onLine?.(line);
        tail.push(line.replace(/token=[^&\s]+/g, "token=…"));
        if (tail.length > 40) tail.shift();
        const ready = settled ? undefined : parseReadyLine(line);
        if (ready) {
          settled = true;
          clearTimeout(timer);
          resolveStart({ ...ready, child, stop });
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", fail);
    child.once("exit", (code, signal) => fail(new Error(`DSH kernel exited (${signal ?? code})`)));
  });
}
