import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { BUNDLES, PROVIDER_ID, profileDir, writeProfile } from "../src/profile.js";
import { parseReadyLine } from "../src/kernel.js";
import { pairingUrl } from "../src/pairing.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "swiftnest-profile-"));
  const bundleDir = join(home, "fake-bundle");
  mkdirSync(bundleDir);
  const config = loadConfig(undefined, { SWIFTNEST_HOME: home, SWIFTNEST_MODEL_ID: "m1" });
  return { config, bundleDir };
}

describe("writeProfile", () => {
  it("stacks DSH base, DSH web, then Swiftnest", () => {
    const { config, bundleDir } = setup();
    const dir = writeProfile(config, { bundleDir });
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dsh.profile.bundles).toEqual([...BUNDLES]);
    expect(readlinkSync(join(dir, "node_modules", "@swiftnest", "server-bundle"))).toBe(bundleDir);
  });

  it("writes the model as an OpenAI-compatible provider and the default model", () => {
    const { config, bundleDir } = setup();
    writeProfile(config, { bundleDir });
    const rows = parse(readFileSync(join(profileDir(config), "cordis.patch.yml"), "utf8"));
    const llm = rows.find((r: { id: string }) => r.id === "llm-pi-ai");
    expect(llm.config.providers[PROVIDER_ID]).toMatchObject({
      api: "openai-completions",
      apiKeyEnv: config.model.apiKeyEnv,
      baseURL: config.model.baseUrl,
      models: [{ id: "m1" }],
    });
    expect(rows.find((r: { id: string }) => r.id === "agent-default-model").config).toEqual({ provider: PROVIDER_ID, model: "m1" });
  });

  it("keeps the operator's user.patch.yml and is idempotent", () => {
    const { config, bundleDir } = setup();
    writeProfile(config, { bundleDir });
    const user = join(profileDir(config), "user.patch.yml");
    writeFileSync(user, "- id: mine\n");
    writeProfile(config, { bundleDir });
    expect(readFileSync(user, "utf8")).toBe("- id: mine\n");
  });
});

describe("kernel output and pairing", () => {
  it("parses the ready line and strips the token from the URL", () => {
    expect(parseReadyLine("dsh web: http://127.0.0.1:3077/?token=abc")).toEqual({ url: "http://127.0.0.1:3077/", token: "abc" });
    expect(parseReadyLine("something else")).toBeUndefined();
  });

  it("builds the App pairing URL", () => {
    expect(pairingUrl("http://192.168.1.5:3077/", "t0k")).toBe("http://192.168.1.5:3077/connect?token=t0k&interactions=answer");
  });
});
