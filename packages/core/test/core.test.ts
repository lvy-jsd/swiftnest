import { qualifiedToolName, parseQualifiedToolName } from "@swiftnest/protocol";
import { describe, expect, it } from "vitest";
import {
  definePlugin,
  fingerprintOf,
  generateIdentity,
  memoryLink,
  MemoryAuditLog,
  Nest,
  Perch,
  RulePolicy,
  silentLogger,
  verifySignature,
  type Capability,
} from "../src/index.js";

function demo(onInvoke?: (signal: AbortSignal) => Promise<string>): Capability {
  return {
    manifest: {
      id: "demo",
      title: "Demo",
      tools: [
        { name: "look", description: "observe", risk: "read" },
        { name: "change", description: "modify", risk: "write" },
        { name: "slow", description: "takes long", risk: "read", defaultTimeoutMs: 200 },
      ],
    },
    async invoke(tool, _args, ctx) {
      if (tool === "slow") return onInvoke ? onInvoke(ctx.signal) : new Promise<string>(() => {});
      return `${tool} done`;
    },
  };
}

async function setup(rules = [] as ConstructorParameters<typeof RulePolicy>[0], approvalTimeoutMs?: number) {
  const audit = new MemoryAuditLog();
  const nest = new Nest({ audit, policy: new RulePolicy(rules), logger: silentLogger, approvalTimeoutMs });
  const perch = new Perch({ device: "dev", logger: silentLogger });
  perch.addCapability(demo());
  nest.attach(memoryLink(perch));
  return { nest, perch, audit, client: { id: "t" } };
}

describe("names", () => {
  it("round-trips qualified tool names", () => {
    expect(qualifiedToolName("laptop", "shell", "run")).toBe("laptop__shell__run");
    expect(parseQualifiedToolName("laptop__shell__run")).toEqual({ device: "laptop", capability: "shell", tool: "run" });
    expect(parseQualifiedToolName("laptop.shell.run")).toBeNull();
    expect(parseQualifiedToolName("Laptop__shell__run")).toBeNull();
  });
});

describe("identity", () => {
  it("signs and verifies, with a human-comparable fingerprint", () => {
    const id = generateIdentity();
    const sig = id.sign("hello");
    expect(verifySignature(id.publicKey, "hello", sig)).toBe(true);
    expect(verifySignature(id.publicKey, "hellO", sig)).toBe(false);
    expect(id.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(fingerprintOf(id.publicKey)).toBe(id.fingerprint);
  });
});

describe("policy", () => {
  it("allows reads and asks for writes by default", () => {
    const p = new RulePolicy();
    const base = { client: { id: "c" }, device: "d", capability: "x", tool: "y", args: {} };
    expect(p.decide({ ...base, risk: "read" }).action).toBe("allow");
    expect(p.decide({ ...base, risk: "write" }).action).toBe("ask");
    expect(p.decide({ ...base, risk: "sensitive" }).action).toBe("ask");
  });
  it("lets rules tighten, but never silently auto-allow sensitive calls", () => {
    const p = new RulePolicy([{ tool: "y", action: "allow" }, { device: "locked", action: "deny" }]);
    const base = { client: { id: "c" }, capability: "x", tool: "y", args: {} };
    expect(p.decide({ ...base, device: "d", risk: "write" }).action).toBe("allow");
    expect(p.decide({ ...base, device: "d", risk: "sensitive" }).action).toBe("ask");
    expect(p.decide({ ...base, device: "locked", tool: "z", risk: "read" }).action).toBe("deny");
  });
});

describe("tasks", () => {
  it("runs allowed calls and audits every transition", async () => {
    const { nest, audit, client } = await setup();
    const t = await nest.call("dev__demo__look", {}, client);
    const done = await nest.tasks.wait(t.id, 1000);
    expect(done.state).toBe("succeeded");
    expect(done.result?.text).toBe("look done");
    expect((await audit.query({ taskId: t.id })).map((e) => e.state)).toEqual(["queued", "running", "succeeded"]);
  });

  it("holds writes for approval, then runs or denies", async () => {
    const { nest, client } = await setup();
    const a = await nest.call("dev__demo__change", {}, client);
    expect(a.state).toBe("pending_approval");
    await nest.tasks.approve(a.id, "owner");
    expect((await nest.tasks.wait(a.id, 1000)).state).toBe("succeeded");

    const b = await nest.call("dev__demo__change", {}, client);
    expect((await nest.tasks.deny(b.id)).state).toBe("denied");
  });

  it("expires approvals that nobody answers", async () => {
    const { nest, client } = await setup([], 50);
    const t = await nest.call("dev__demo__change", {}, client);
    const done = await nest.tasks.wait(t.id, 1000);
    expect(done.state).toBe("denied");
    expect(done.error?.message).toMatch(/expired/);
  });

  it("applies deny rules", async () => {
    const { nest, client } = await setup([{ capability: "demo", action: "deny" }]);
    const t = await nest.call("dev__demo__look", {}, client);
    expect(t.state).toBe("denied");
  });

  it("times out and cancels long calls on the device", async () => {
    let aborted = false;
    const audit = new MemoryAuditLog();
    const nest = new Nest({ audit, logger: silentLogger });
    const perch = new Perch({ device: "dev", logger: silentLogger });
    perch.addCapability(demo((signal) => new Promise((_, rej) => signal.addEventListener("abort", () => ((aborted = true), rej(signal.reason))))));
    nest.attach(memoryLink(perch));
    const t = await nest.call("dev__demo__slow", {}, { id: "t" });
    const done = await nest.tasks.wait(t.id, 2000);
    expect(done.state).toBe("timed_out");
    expect(aborted).toBe(true);

    const c = await nest.call("dev__demo__slow", {}, { id: "t" }, 10_000);
    await new Promise((r) => setTimeout(r, 20));
    expect((await nest.tasks.cancel(c.id)).state).toBe("cancelled");
  });

  it("fails clearly for offline devices and bad names", async () => {
    const { nest, client } = await setup();
    const t = await nest.call("ghost__demo__look", {}, client);
    expect(t.state).toBe("failed");
    expect(t.error?.code).toBe("DEVICE_OFFLINE");
    expect(t.error?.suggestion).toBeTruthy();
    expect(() => nest.call("not-a-tool", {}, client)).toThrow(expect.objectContaining({ code: "BAD_TOOL_NAME", suggestion: expect.stringMatching(/<device>__<capability>__<tool>/) }));
  });

  it("queues calls beyond the per-device concurrency limit", async () => {
    const nest = new Nest({ logger: silentLogger, maxConcurrentPerDevice: 1 });
    const perch = new Perch({ device: "dev", logger: silentLogger });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    perch.addCapability(demo(async () => (await gate, "slow done")));
    nest.attach(memoryLink(perch));
    const a = await nest.call("dev__demo__slow", {}, { id: "t" }, 5000);
    const b = await nest.call("dev__demo__look", {}, { id: "t" });
    await new Promise((r) => setTimeout(r, 20));
    expect(nest.tasks.get(b.id)?.state).toBe("queued");
    release();
    expect((await nest.tasks.wait(a.id, 1000)).state).toBe("succeeded");
    expect((await nest.tasks.wait(b.id, 1000)).state).toBe("succeeded");
  });
});

describe("plugins and devices", () => {
  it("rejects plugins for the wrong role or API version, with a fix", async () => {
    const perch = new Perch({ device: "dev", logger: silentLogger });
    const nestOnly = definePlugin({ name: "x", kind: "surface", apiVersion: 1, runsOn: "nest", setup() {} });
    await expect(perch.use(nestOnly)).rejects.toMatchObject({ code: "PLUGIN_WRONG_ROLE", suggestion: expect.stringMatching(/server/) });
    const future = definePlugin({ name: "y", kind: "capability", apiVersion: 99, runsOn: "perch", setup() {} });
    await expect(perch.use(future)).rejects.toMatchObject({ code: "PLUGIN_API_MISMATCH" });
  });

  it("refuses a second device under the same name with a different key", async () => {
    const nest = new Nest({ logger: silentLogger });
    nest.attach(memoryLink(new Perch({ device: "dup", logger: silentLogger })));
    expect(() => nest.attach(memoryLink(new Perch({ device: "dup", logger: silentLogger })))).toThrow(/already registered/);
  });

  it("tracks devices going offline", async () => {
    const { nest } = await setup();
    const link = memoryLink(new Perch({ device: "other", logger: silentLogger }));
    nest.attach(link);
    expect(nest.devices().map((d) => d.device).sort()).toEqual(["dev", "other"]);
    link.close();
    expect(nest.devices().map((d) => d.device)).toEqual(["dev"]);
  });
});
