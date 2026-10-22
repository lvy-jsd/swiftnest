/** Minimal leveled logger. SWIFTNEST_LOG=debug|info|warn|error (default info). Writes to stderr so stdio MCP stays clean. */
export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

export function createLogger(scope = "swiftnest", level: Level = (process.env.SWIFTNEST_LOG as Level) ?? "info"): Logger {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lv: Level, msg: string, extra?: unknown) => {
    if (LEVELS[lv] < min) return;
    const tail = extra === undefined ? "" : " " + (extra instanceof Error ? extra.stack ?? extra.message : JSON.stringify(extra));
    process.stderr.write(`[${new Date().toISOString()}] ${lv.toUpperCase()} ${scope}: ${msg}${tail}\n`);
  };
  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
    child: (s) => createLogger(`${scope}/${s}`, level),
  };
}

/** A logger that drops everything (tests, quiet embedding). */
export const silentLogger: Logger = createLogger("silent", "silent");
