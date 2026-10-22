import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlugin, pluginName, SDK_VERSION } from "../src/index.js";

describe("create-swiftnest-plugin", () => {
  it("derives a conventional package name", () => {
    expect(pluginName("my-tool")).toBe("swiftnest-plugin-my-tool");
    expect(pluginName("swiftnest-plugin-x")).toBe("swiftnest-plugin-x");
    expect(pluginName("x", "@me/swiftnest-plugin-x")).toBe("@me/swiftnest-plugin-x");
  });

  it("scaffolds a standalone plugin from the template", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "swiftnest-create-")), "weather");
    await createPlugin(dir, "swiftnest-plugin-weather");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("swiftnest-plugin-weather");
    expect(pkg.private).toBeUndefined();
    expect(pkg.dependencies["@swiftnest/sdk"]).toBe(SDK_VERSION);
    expect(pkg.swiftnest).toMatchObject({ apiVersion: 1, kind: "capability", runsOn: "perch" });
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toContain('name: "swiftnest-plugin-weather"');
    expect(readFileSync(join(dir, "test", "plugin.test.ts"), "utf8")).toContain("createTestNest");
    expect(JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).extends).toBeUndefined();
  });

  it("refuses to overwrite a non-empty directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swiftnest-create-"));
    await createPlugin(join(dir, "a"), "swiftnest-plugin-a");
    await expect(createPlugin(join(dir, "a"), "swiftnest-plugin-a")).rejects.toThrow(/not empty/);
  });
});
