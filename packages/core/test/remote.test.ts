import { describe, expect, it } from "vitest";
import {
  acceptChannel,
  acceptPerch,
  connectToNest,
  fingerprintOf,
  generateIdentity,
  initiateChannel,
  memoryTransportPair,
  MemoryDeviceStore,
  Nest,
  PairingManager,
  Perch,
  RulePolicy,
  silentLogger,
  type Capability,
  type FrameTransport,
} from "../src/index.js";

const client = { id: "test-client", name: "test" };

function demo(): Capability {
  return {
    manifest: {
      id: "demo",
      title: "Demo",
      tools: [
        { name: "look", description: "observe", risk: "read" },
        { name: "change", description: "modify", risk: "write" },
        { name: "slow", description: "waits until cancelled", risk: "read" },
      ],
    },
    async invoke(tool, args, ctx) {
      if (tool === "slow") {
        return new Promise<string>((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
      }
      return `${tool}:${JSON.stringify(args)}`;
    },
  };
}

/** Wrap a transport so a test can rewrite or duplicate what it sends. */
function tap(t: FrameTransport, rewrite: (data: string, n: number) => string[]): FrameTransport {
  let n = 0;
  return { ...t, send: (d) => rewrite(d, n++).forEach((x) => t.send(x)) };
}

describe("secure channel", () => {
  it("authenticates both sides and carries messages both ways", async () => {
    const nestId = generateIdentity();
    const perchId = generateIdentity();
    const [a, b] = memoryTransportPair();
    const [accepted, initiated] = await Promise.all([
      acceptChannel(b, { identity: nestId }),
      initiateChannel(a, { identity: perchId, device: "laptop", expectedPeer: nestId.publicKey }),
    ]);
    expect(initiated.peerPublicKey).toBe(nestId.publicKey);
    expect(accepted.channel.peerPublicKey).toBe(perchId.publicKey);
    expect(accepted.hello.device).toBe("laptop");
    expect(initiated.transcriptHash.equals(accepted.channel.transcriptHash)).toBe(true);

    const got: unknown[] = [];
    accepted.channel.onMessage((m) => got.push(m));
    initiated.send({ hi: 1 });
    initiated.send({ hi: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ hi: 1 }, { hi: 2 }]);
  });

  it("refuses a Nest whose key is not the pinned one", async () => {
    const [a, b] = memoryTransportPair();
    void acceptChannel(b, { identity: generateIdentity() }).catch(() => {});
    await expect(initiateChannel(a, { identity: generateIdentity(), device: "laptop", expectedPeer: generateIdentity().publicKey })).rejects.toMatchObject({ code: "NEST_KEY_CHANGED" });
  });

  it("closes on a tampered frame and on a replayed frame", async () => {
    for (const attack of ["tamper", "replay"] as const) {
      const nestId = generateIdentity();
      const [a, b] = memoryTransportPair();
      // Perch frames: 0 = hs1 (plain), 1 = auth, 2 = the first application message.
      const evil = tap(a, (d, n) => {
        if (n !== 2) return [d];
        if (attack === "replay") return [d, d];
        const bytes = Buffer.from(d, "base64url");
        bytes[10] ^= 1;
        return [bytes.toString("base64url")];
      });
      const [accepted, initiated] = await Promise.all([acceptChannel(b, { identity: nestId }), initiateChannel(evil, { identity: generateIdentity(), device: "x", expectedPeer: nestId.publicKey })]);
      const got: unknown[] = [];
      accepted.channel.onMessage((m) => got.push(m));
      const closed = new Promise<string | undefined>((r) => accepted.channel.onClose(r));
      initiated.send({ n: 1 });
      expect(await closed).toBe("integrity check failed");
      expect(got).toEqual(attack === "replay" ? [{ n: 1 }] : []);
    }
  });
});

async function setup(o: { pairOwner?: boolean; pairDevice?: boolean; code?: string } = {}) {
  const nestId = generateIdentity();
  const perchId = generateIdentity();
  const devices = new MemoryDeviceStore();
  const pairing = new PairingManager();
  const nest = new Nest({ identity: nestId, policy: new RulePolicy(), logger: silentLogger });
  const perch = await new Perch({ device: "laptop", identity: perchId, logger: silentLogger }).use({ name: "demo", kind: "capability", apiVersion: 1, runsOn: "perch", setup: (ctx) => (ctx.role === "perch" ? ctx.provideCapability(demo()) : undefined) });
  const connect = async (pairingCode?: string, nestKey?: string) => {
    const [a, b] = memoryTransportPair();
    const nestSide = acceptPerch(nest, b, { identity: nestId, devices, pairing, via: "memory", logger: silentLogger, confirmTimeoutMs: 2_000 });
    let shown = "";
    const perchSide = connectToNest(perch, a, {
      identity: perchId,
      nestKey,
      pairing: pairingCode === undefined ? undefined : { code: pairingCode, confirm: async (fp) => ((shown = fp), o.pairDevice ?? true) },
      confirmTimeoutMs: 2_000,
    });
    return { nestSide, perchSide, shown: () => shown };
  };
  pairing.onCandidate((c) => setTimeout(() => pairing.confirm(c.id, o.pairOwner ?? true), 5));
  return { nest, perch, nestId, perchId, devices, pairing, connect };
}

describe("pairing and remote devices", () => {
  it("pairs with a code and two fingerprint confirmations, then reconnects with the pinned key", async () => {
    const s = await setup();
    const { code } = s.pairing.start();
    let candidateFp = "";
    s.pairing.onCandidate((c) => (candidateFp = c.fingerprint));
    const first = await s.connect(code);
    const [conn, session] = await Promise.all([first.nestSide, first.perchSide]);
    expect(first.shown()).toBe(fingerprintOf(s.nestId.publicKey));
    expect(candidateFp).toBe(fingerprintOf(s.perchId.publicKey));
    expect(s.devices.get("laptop")?.publicKey).toBe(s.perchId.publicKey);
    expect(conn.via).toBe("memory");
    expect(session.nestKey).toBe(s.nestId.publicKey);
    expect(s.pairing.active).toBe(false); // one device per code

    session.close();
    await session.closed;
    const again = await s.connect(undefined, session.nestKey);
    await Promise.all([again.nestSide, again.perchSide]);
    expect(s.nest.devices().map((d) => d.device)).toEqual(["laptop"]);
  });

  it("refuses an unpaired device, a wrong code, and a pairing either person does not confirm", async () => {
    const s = await setup();
    const stranger = await s.connect(undefined, s.nestId.publicKey);
    await expect(stranger.nestSide).rejects.toMatchObject({ code: "NOT_PAIRED" });
    await expect(stranger.perchSide).rejects.toBeTruthy();

    s.pairing.start();
    const wrong = await s.connect("not-the-code");
    await expect(wrong.nestSide).rejects.toMatchObject({ code: "PAIRING_REJECTED" });
    await expect(wrong.perchSide).rejects.toMatchObject({ code: "PAIRING_REJECTED" });

    for (const who of ["owner", "device"] as const) {
      const t = await setup(who === "owner" ? { pairOwner: false } : { pairDevice: false });
      const { code } = t.pairing.start();
      const c = await t.connect(code);
      await expect(c.nestSide).rejects.toMatchObject({ code: "PAIRING_REJECTED" });
      await expect(c.perchSide).rejects.toMatchObject({ code: "PAIRING_REJECTED" });
      expect(t.devices.list()).toEqual([]);
    }
  });

  it("drops a code after too many wrong attempts", async () => {
    const p = new PairingManager({ maxAttempts: 3 });
    p.start();
    for (let i = 0; i < 3; i++) expect(p.verify("nope", Buffer.alloc(32))).toBe(false);
    expect(p.active).toBe(false);
  });

  it("runs calls on the device, cancels them there, follows capability changes, and ends on revoke", async () => {
    const s = await setup();
    const { code } = s.pairing.start();
    const c = await s.connect(code);
    const [, session] = await Promise.all([c.nestSide, c.perchSide]);

    const look = await s.nest.call("laptop__demo__look", { a: 1 }, client);
    const done = await s.nest.tasks.wait(look.id, 2_000);
    expect(done.state).toBe("succeeded");
    expect(done.result?.text).toBe('look:{"a":1}');

    const change = await s.nest.call("laptop__demo__change", {}, client);
    expect(change.state).toBe("pending_approval"); // write asks by default

    const slow = await s.nest.call("laptop__demo__slow", {}, client);
    await new Promise((r) => setTimeout(r, 20));
    await s.nest.tasks.cancel(slow.id);
    expect((await s.nest.tasks.wait(slow.id, 2_000)).state).toBe("cancelled");

    const changed = new Promise<void>((r) => s.nest.onToolsChanged(() => r()));
    s.perch.addCapability({ manifest: { id: "extra", title: "Extra", tools: [{ name: "ping", description: "ping", risk: "read" }] }, invoke: async () => "pong" });
    await changed;
    expect(s.nest.tools().map((t) => t.name)).toContain("laptop__extra__ping");

    s.nest.devices(); // still online
    const conn = (s.nest as unknown as { conns: Map<string, { conn: { close(code: string, message: string): void } }> }).conns.get("laptop")!.conn;
    conn.close("REVOKED", "This device was revoked on the Nest.");
    expect(await session.closed).toEqual({ code: "REVOKED", message: "This device was revoked on the Nest." });
    expect(s.nest.devices()).toEqual([]);
  });

  it("fails a running call when the device drops", async () => {
    const s = await setup();
    const { code } = s.pairing.start();
    const c = await s.connect(code);
    const [, session] = await Promise.all([c.nestSide, c.perchSide]);
    const slow = await s.nest.call("laptop__demo__slow", {}, client);
    await new Promise((r) => setTimeout(r, 20));
    session.close();
    const end = await s.nest.tasks.wait(slow.id, 2_000);
    expect(end.state).toBe("failed");
    expect(end.error?.code).toBe("DEVICE_OFFLINE");
  });
});
