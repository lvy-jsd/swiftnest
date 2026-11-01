import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PORT, loadConfig } from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "swiftnest-config-"));

describe("loadConfig", () => {
  it("has stranger-safe defaults", () => {
    const c = loadConfig(undefined, { XDG_DATA_HOME: "/data" });
    expect(c.home).toBe("/data/swiftnest");
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.model).toEqual(DEFAULT_MODEL);
  });

  it("merges file, then environment", () => {
    const dir = tmp();
    const file = join(dir, "swiftnest.yaml");
    writeFileSync(file, "port: 4000\nmodel:\n  baseUrl: http://10.0.0.2:8000/v1\n  id: from-file\n");
    const c = loadConfig(file, { SWIFTNEST_HOME: dir, SWIFTNEST_MODEL_ID: "from-env" });
    expect(c.port).toBe(4000);
    expect(c.model.baseUrl).toBe("http://10.0.0.2:8000/v1");
    expect(c.model.id).toBe("from-env");
    expect(c.model.contextWindow).toBe(DEFAULT_MODEL.contextWindow);
  });

  it("refuses wildcard hosts, bad ports and bad URLs", () => {
    expect(() => loadConfig(undefined, { SWIFTNEST_HOST: "0.0.0.0" })).toThrow(/wildcard/);
    expect(() => loadConfig(undefined, { SWIFTNEST_PORT: "70000" })).toThrow(/port/);
    expect(() => loadConfig(undefined, { SWIFTNEST_MODEL_BASE_URL: "not a url" })).toThrow(/baseUrl/);
  });

  it("reports a missing config file", () => {
    expect(() => loadConfig("/nonexistent/swiftnest.yaml", {})).toThrow(/not found/);
  });
});
