/**
 * Owner control of a running Nest: a Unix socket (mode 600, in the state directory) speaking one JSON request per line.
 * Only the local user can reach it, which is the whole authentication. `swiftnest pair / devices / revoke / pending /
 * approve / deny / audit` are thin clients of it, so the Nest can run headless under a service manager.
 */
import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { SwiftnestFailure, type Nest } from "@swiftnest/core";

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export function adminHandlers(nest: Nest): Record<string, Handler> {
  return {
    status: () => ({ fingerprint: nest.identity.fingerprint, online: nest.devices().length, paired: nest.devicesStore.list().length }),
    "pair.start": () => ({ ...nest.pairing.start(), fingerprint: nest.identity.fingerprint }),
    "pair.stop": () => (nest.pairing.stop(), { ok: true }),
    "pair.pending": () => nest.pairing.pending(),
    "pair.confirm": (p) => ({ ok: nest.pairing.confirm(String(p.id), p.accept === true) }),
    devices: () => {
      const online = new Map(nest.devices().map((d) => [d.device, d]));
      return nest.devicesStore.list().map((d) => ({ ...d, online: online.has(d.device), via: online.get(d.device)?.via, capabilities: online.get(d.device)?.capabilities ?? [] }));
    },
    revoke: async (p) => ({ ok: await nest.revoke(String(p.device)) }),
    "tasks.pending": () => nest.tasks.list({ state: "pending_approval" }),
    "tasks.approve": async (p) => nest.tasks.approve(String(p.id), "admin socket"),
    "tasks.deny": async (p) => nest.tasks.deny(String(p.id), "denied with swiftnest deny"),
    "audit.tail": async (p) => nest.audit.query({ limit: typeof p.limit === "number" ? p.limit : 20, device: typeof p.device === "string" ? p.device : undefined }),
  };
}

export async function serveAdmin(path: string, handlers: Record<string, Handler>): Promise<{ close(): Promise<void> }> {
  await rm(path, { force: true });
  const server: Server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 1_000_000) return sock.destroy();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void (async () => {
          let id: unknown;
          try {
            const req = JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
            id = req.id;
            const h = handlers[String(req.method)];
            if (!h) throw new SwiftnestFailure("UNKNOWN_METHOD", `Unknown admin method ${String(req.method)}.`);
            sock.write(JSON.stringify({ id, result: (await h(req.params ?? {})) ?? null }) + "\n");
          } catch (e) {
            sock.write(JSON.stringify({ id, error: SwiftnestFailure.from(e, "ADMIN_FAILED") }) + "\n");
          }
        })();
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  return { close: () => new Promise<void>((r) => server.close(() => void rm(path, { force: true }).then(() => r()))) };
}

/** One request to a running Nest. */
export function adminCall<T = unknown>(path: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    sock.setEncoding("utf8");
    sock.once("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? new SwiftnestFailure("NEST_NOT_RUNNING", "No Nest is running for this user.", "Start it first with `swiftnest nest` (in another terminal or as a service).")
          : e,
      ),
    );
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      sock.end();
      const res = JSON.parse(buf.slice(0, nl)) as { result?: T; error?: { code: string; message: string; suggestion?: string } };
      res.error ? reject(new SwiftnestFailure(res.error.code, res.error.message, res.error.suggestion)) : resolve(res.result as T);
    });
    sock.write(JSON.stringify({ id: 1, method, params }) + "\n");
  });
}
