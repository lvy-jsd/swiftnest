import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PORT, DEFAULT_PERSONA, loadConfig } from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "swiftnest-config-"));

describe("loadConfig", () => {
  it("has stranger-safe defaults", () => {
    const c = loadConfig(undefined, { XDG_DATA_HOME: "/data" });
    expect(c.home).toBe("/data/swiftnest");
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.model).toEqual(DEFAULT_MODEL);
    expect(c.persona).toBe(DEFAULT_PERSONA);
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

  it("reads a persona from YAML, with an environment override and string validation", () => {
    const file = join(tmp(), "persona.yaml");
    writeFileSync(file, 'persona: "You are the YAML assistant, powered by {{model}}."\n');
    expect(loadConfig(file, {}).persona).toBe("You are the YAML assistant, powered by {{model}}.");
    expect(loadConfig(file, { SWIFTNEST_PERSONA: "You are the env assistant." }).persona).toBe("You are the env assistant.");
    expect(loadConfig(file, { SWIFTNEST_PERSONA: "" }).persona).toBe("");
    writeFileSync(file, "persona: 42\n");
    expect(() => loadConfig(file, {})).toThrow("persona must be a string");
  });

  it('resolves App dist from YAML with an environment override', () => {
    const dir = tmp(); const file = join(dir, 'app.yaml');
    writeFileSync(file, `appDist: ${dir}/file-dist\n`);
    expect(loadConfig(file, {}).appDist).toBe(join(dir, 'file-dist'));
    expect(loadConfig(file, { SWIFTNEST_APP_DIST: join(dir, 'env-dist') }).appDist).toBe(join(dir, 'env-dist'));
  });
});
