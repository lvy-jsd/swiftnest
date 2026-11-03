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

  it('defaults the device listener to the server host and validates its configuration', () => {
    expect(loadConfig(undefined, { SWIFTNEST_HOST: '192.168.1.20' }).devices).toEqual({ host: '192.168.1.20', port: 7711, mdns: true });
    const file = join(tmp(), 'devices.yml');
    writeFileSync(file, 'devices:\n  host: 127.0.0.1\n  port: 0\n  mdns: false\n');
    expect(loadConfig(file, {}).devices).toEqual({ host: '127.0.0.1', port: 0, mdns: false });
    expect(() => loadConfig(undefined, { SWIFTNEST_DEVICES_PORT: '-1' })).toThrow('devices.port');
    writeFileSync(file, 'devices:\n  mdns: bad\n');
    expect(() => loadConfig(file, {})).toThrow('devices.mdns');
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

  it("reads the assistant's display name from YAML, with an environment override", () => {
    const file = join(tmp(), "assistant.yaml");
    writeFileSync(file, 'assistantName: "小艾"\n');
    expect(loadConfig(undefined, {}).assistantName).toBeUndefined();
    expect(loadConfig(file, {}).assistantName).toBe("小艾");
    expect(loadConfig(file, { SWIFTNEST_ASSISTANT_NAME: "Ivy" }).assistantName).toBe("Ivy");
  });

  it('resolves App dist from YAML with an environment override', () => {
    const dir = tmp(); const file = join(dir, 'app.yaml');
    writeFileSync(file, `appDist: ${dir}/file-dist\n`);
    expect(loadConfig(file, {}).appDist).toBe(join(dir, 'file-dist'));
    expect(loadConfig(file, { SWIFTNEST_APP_DIST: join(dir, 'env-dist') }).appDist).toBe(join(dir, 'env-dist'));
  });
});

it("defaults Tool Ultra on and supports YAML and environment overrides", () => {
  const file = join(tmp(), "ultra.yaml");
  expect(loadConfig(undefined, {}).toolUltra).toBe(true);
  writeFileSync(file, "toolUltra: false\n");
  expect(loadConfig(file, {}).toolUltra).toBe(false);
  expect(loadConfig(file, { SWIFTNEST_TOOL_ULTRA: "true" }).toolUltra).toBe(true);
  expect(loadConfig(undefined, { SWIFTNEST_TOOL_ULTRA: "false" }).toolUltra).toBe(false);
  writeFileSync(file, 'toolUltra: "false"\n');
  expect(() => loadConfig(file, {})).toThrow("toolUltra must be a boolean");
});

it.each(["42", "false", "[]", "{}", "null"])("rejects non-string assistantName: %s", value => {
  const file = join(tmp(), "assistant.yaml");
  writeFileSync(file, `assistantName: ${value}\n`);
  expect(() => loadConfig(file, {})).toThrow("assistantName must be a string");
});
