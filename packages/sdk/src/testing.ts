/**
 * Simulated Nest + devices for plugin tests and the playground. Devices connect over the in-process memory link,
 * so a test runs in milliseconds and needs no network, pairing or real hardware.
 */
import { memoryLink, MemoryAuditLog, Nest, Perch, RulePolicy, silentLogger, type Logger, type PolicyRule, type SwiftnestPlugin } from "@swiftnest/core";
import type { ClientRef, TaskSnapshot } from "@swiftnest/protocol";

export interface TestDevice {
  name: string;
  plugins: (SwiftnestPlugin | [SwiftnestPlugin, Record<string, unknown>])[];
}

export interface TestNest {
  nest: Nest;
  audit: MemoryAuditLog;
  perches: Map<string, Perch>;
  /**
   * Call `<device>__<capability>__<tool>` and wait for the outcome.
   * `approve: true` approves the call if the policy asks for a person (tests only — real approvals come from people).
   */
  call(name: string, args?: Record<string, unknown>, opts?: { approve?: boolean; client?: ClientRef; waitMs?: number }): Promise<TaskSnapshot>;
  close(): Promise<void>;
}

export async function createTestNest(opts: { devices: TestDevice[]; rules?: PolicyRule[]; logger?: Logger }): Promise<TestNest> {
  const audit = new MemoryAuditLog();
  const logger = opts.logger ?? silentLogger;
  const nest = new Nest({ audit, policy: new RulePolicy(opts.rules), logger });
  const perches = new Map<string, Perch>();
  for (const d of opts.devices) {
    const perch = new Perch({ device: d.name, logger });
    for (const p of d.plugins) {
      const [plugin, config] = Array.isArray(p) ? p : [p, {}];
      await perch.use(plugin, config);
    }
    perches.set(d.name, perch);
    nest.attach(memoryLink(perch));
  }
  return {
    nest,
    audit,
    perches,
    async call(name, args = {}, o = {}) {
      const task = await nest.call(name, args, o.client ?? { id: "test", name: "createTestNest" });
      if (task.state === "pending_approval" && o.approve) await nest.tasks.approve(task.id, "test");
      return nest.tasks.wait(task.id, o.waitMs ?? 10_000);
    },
    async close() {
      await nest.close();
      for (const p of perches.values()) await p.close();
    },
  };
}
