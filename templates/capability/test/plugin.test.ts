import { afterEach, describe, expect, it } from "vitest";
import { createTestNest, type TestNest } from "@swiftnest/sdk";
import plugin from "../src/index.js";

describe("hello capability", () => {
  let t: TestNest;
  afterEach(() => t?.close());

  it("greets through a simulated Nest", async () => {
    t = await createTestNest({ devices: [{ name: "sim", plugins: [[plugin, { greeting: "Hi" }]] }] });
    const task = await t.call("sim__hello__greet", { name: "Swift" });
    expect(task.state).toBe("succeeded");
    expect(task.result?.text).toBe("Hi, Swift!");
  });

  it("shows up with a device-prefixed tool name", async () => {
    t = await createTestNest({ devices: [{ name: "laptop", plugins: [plugin] }] });
    expect(t.nest.tools().map((x) => x.name)).toContain("laptop__hello__greet");
  });
});
