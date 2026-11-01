/**
 * swiftnest-core: the first built-in module. It only adds a route; DSH's own
 * routes and Web UI stay untouched.
 *
 * `GET /swiftnest/health` answers without authentication and reveals nothing
 * private: versions and whether the configured model endpoint answers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const name = "swiftnest-core";
export const inject = ["webServer"];

export interface CoreConfig {
  version?: string;
  modelBaseUrl?: string;
}

interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

interface CoreContext {
  webServer: { register(route: WebRoute): () => void };
  effect(fn: () => () => void, label?: string): void;
}

export interface Health {
  ok: true;
  swiftnest: string;
  dsh: string;
  model: { configured: boolean; reachable: boolean | null };
}

/** How long the health route waits for the model endpoint before reporting it unreachable. */
const MODEL_PROBE_TIMEOUT_MS = 2000;

export async function probeModel(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  if (!baseUrl) return null;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
    });
    // Some OpenAI-compatible gateways do not implement /models; any answer below 500 means the server is up.
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function health(config: CoreConfig, dshVersion: string, fetchImpl?: typeof fetch): Promise<Health> {
  return {
    ok: true,
    swiftnest: config.version ?? "dev",
    dsh: dshVersion,
    model: { configured: Boolean(config.modelBaseUrl), reachable: await probeModel(config.modelBaseUrl, fetchImpl) },
  };
}

export function apply(ctx: CoreContext, config: CoreConfig = {}): void {
  const dshVersion = process.env.SWIFTNEST_DSH_VERSION ?? "unknown";
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/swiftnest/health",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }
          const body = JSON.stringify(await health(config, dshVersion));
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
        },
      }),
    "swiftnest-core: /swiftnest/health",
  );
}
