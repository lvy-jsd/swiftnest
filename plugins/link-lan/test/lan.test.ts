import { generateIdentity, MemoryDeviceStore, Nest, Perch, RulePolicy, silentLogger, type Capability, type PairingManager } from "@swiftnest/core";
import makeMdns from "multicast-dns";
import { describe, expect, it } from "vitest";
import { discover, runLanPerch, serveLan, type PerchState } from "../src/index.js";

/** Can this machine hear its own multicast? A host firewall that drops UDP 5353 (NixOS's default) cannot. */
async function multicastWorks(): Promise<boolean> {
  const name = `_probe-${process.pid}._tcp.local`;
  const a = makeMdns();
  const b = makeMdns();
  try {
    return await new Promise<boolean>((resolve) => {
      a.on("query", (q) => {
        if (q.questions.some((x) => x.name === name)) resolve(true);
      });
      setTimeout(() => b.query({ questions: [{ name, type: "PTR" }] }), 100);
      setTimeout(() => resolve(false), 1_000);
    });
  } finally {
    a.destroy();
    b.destroy();
  }
}
const mdnsOk = process.env.SWIFTNEST_SKIP_MDNS !== "1" && (await multicastWorks());
if (!mdnsOk) console.warn("link-lan: multicast does not reach this machine (firewall?); skipping the mDNS test");

const client = { id: "test", name: "test" };
const echo: Capability = {
  manifest: { id: "echo", title: "Echo", tools: [{ name: "say", description: "echo", risk: "read" }] },
  invoke: async (_t, args) => String(args.text),
};

async function makePerch(name = "laptop") {
  return new Perch({ device: name, logger: silentLogger }).use({
    name: "echo",
    kind: "capability",
    apiVersion: 1,
    runsOn: "perch",
    setup: (ctx) => (ctx.role === "perch" ? ctx.provideCapability(echo) : undefined),
  });
}

function autoConfirm(pairing: PairingManager) {
  pairing.onCandidate((c) => setTimeout(() => pairing.confirm(c.id, true), 5));
}

function until(states: PerchState[], wanted: PerchState, ms = 8_000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never reached ${wanted}; saw ${states.join(" → ")}`)), ms);
    const check = setInterval(() => {
      if (states.at(-1) === wanted) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
}

describe("link-lan", () => {
  it("pairs over a real WebSocket, runs calls, and stops for good when revoked", async () => {
    const nest = new Nest({ policy: new RulePolicy(), logger: silentLogger, devices: new MemoryDeviceStore() });
    autoConfirm(nest.pairing);
    const server = await serveLan(nest, { host: "127.0.0.1", port: 0, advertise: false, logger: silentLogger });
    const perch = await makePerch();
    const { code } = nest.pairing.start();
    const states: PerchState[] = [];
    let pinned = "";
    const run = runLanPerch(perch, {
      url: server.url,
      pairing: { code, confirm: async () => true },
      onPaired: (key) => void (pinned = key),
      onStatus: (s) => states.push(s),
    });
    await until(states, "online");
    expect(pinned).toBe(nest.identity.publicKey);
    expect(nest.devices()[0]).toMatchObject({ device: "laptop", via: "lan" });

    const task = await nest.call("laptop__echo__say", { text: "echo ok" }, client);
    expect((await nest.tasks.wait(task.id, 3_000)).result?.text).toBe("echo ok");

    await nest.revoke("laptop");
    expect(await run.finished).toMatchObject({ code: "REVOKED" });
    expect(nest.devicesStore.list()).toEqual([]);
    await server.close();
  });

  it("gives up at once when the device is not paired", async () => {
    const nest = new Nest({ logger: silentLogger });
    const server = await serveLan(nest, { host: "127.0.0.1", port: 0, advertise: false, logger: silentLogger });
    const run = runLanPerch(await makePerch(), { url: server.url, nestKey: nest.identity.publicKey });
    expect(await run.finished).toMatchObject({ code: "NOT_PAIRED" });
    await server.close();
  });

  it("reconnects by itself when the Nest restarts, and disconnects locally on stop()", async () => {
    const identity = generateIdentity();
    const devices = new MemoryDeviceStore();
    const nest1 = new Nest({ identity, devices, logger: silentLogger });
    autoConfirm(nest1.pairing);
    const s1 = await serveLan(nest1, { host: "127.0.0.1", port: 0, advertise: false, logger: silentLogger });
    const port = s1.port;
    const { code } = nest1.pairing.start();
    const states: PerchState[] = [];
    const run = runLanPerch(await makePerch(), { url: s1.url, pairing: { code, confirm: async () => true }, onStatus: (s) => states.push(s) });
    await until(states, "online");

    await s1.close();
    await until(states, "offline");
    const nest2 = new Nest({ identity, devices, logger: silentLogger });
    const s2 = await serveLan(nest2, { host: "127.0.0.1", port, advertise: false, logger: silentLogger });
    await until(states, "online", 10_000);
    expect(nest2.devices().map((d) => d.device)).toEqual(["laptop"]);

    run.stop();
    expect(await run.finished).toMatchObject({ code: "DEVICE_DISCONNECTED" });
    await new Promise((r) => setTimeout(r, 50));
    expect(nest2.devices()).toEqual([]);
    await s2.close();
  });

  it.skipIf(!mdnsOk)("is found with mDNS", async () => {
    const nest = new Nest({ logger: silentLogger });
    const server = await serveLan(nest, { port: 0, logger: silentLogger });
    const found = await discover(1_500);
    await server.close();
    const mine = found.find((n) => n.fingerprint === nest.identity.fingerprint);
    expect(mine?.url).toMatch(new RegExp(`^ws://.+:${server.port}/swiftnest$`));
  });
});
