/**
 * Boots the real pinned DSH kernel on the swiftnest profile. Opt-in
 * (SWIFTNEST_E2E=1) because it needs the official Node build and takes a few
 * seconds; CI runs it in the server job.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startKernel, type RunningKernel } from "../src/kernel.js";
import { pairingUrl } from "../src/pairing.js";

const enabled = process.env.SWIFTNEST_E2E === "1";

describe.skipIf(!enabled)("Swiftnest Server kernel (e2e)", () => {
  let model: Server;
  let kernel: RunningKernel;

  beforeAll(async () => {
    model = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fake" }] }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    const modelPort = (model.address() as AddressInfo).port;
    const config = loadConfig(undefined, {
      SWIFTNEST_HOME: mkdtempSync(join(tmpdir(), "swiftnest-e2e-")),
      SWIFTNEST_PORT: "0",
      SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      SWIFTNEST_MODEL_ID: "fake",
    });
    kernel = await startKernel(config, { readyTimeoutMs: 90_000 });
  }, 120_000);

  afterAll(async () => {
    await kernel?.stop();
    await new Promise((r) => model?.close(r));
  });

  it("serves /swiftnest/health from the built-in module", async () => {
    const res = await fetch(new URL("swiftnest/health", kernel.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dsh: "0.2.1-rc.5", model: { configured: true, reachable: true } });
  });

  it("keeps DSH's native API behind authentication", async () => {
    expect((await fetch(new URL("api", kernel.url), { method: "POST" })).status).toBe(401);
  });

  it("lets an App trade the launch token for an API session", async () => {
    const res = await fetch(pairingUrl(kernel.url, kernel.token), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("./api/remote.mux");
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });
});
