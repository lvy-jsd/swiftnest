/**
 * The Nest's view of a connected Perch. Link plugins (LAN, relay, Headscale…) each provide one of these per device;
 * the in-process `memoryLink` here powers the playground, tests and single-machine ("no Nest") setups.
 */
import type { CapabilityManifest, InvokeRequest, InvokeResult, Risk } from "@swiftnest/protocol";
import type { z } from "zod";
import type { Perch } from "./perch.js";

export interface PerchConnection {
  readonly device: string;
  readonly publicKey: string;
  /** Which link plugin carries it ("memory", "lan", "relay", "headscale"…), shown in the panel. */
  readonly via: string;
  capabilities(): CapabilityManifest[];
  classify(capability: string, tool: string, args: Record<string, unknown>): Promise<{ risk: Risk; reason?: string }>;
  invoke(req: Omit<z.infer<typeof InvokeRequest>, "type">): Promise<z.infer<typeof InvokeResult>>;
  cancel(taskId: string): void;
  onCapabilitiesChanged(fn: () => void): () => void;
  onClose(fn: () => void): () => void;
  close(): void;
}

export function memoryLink(perch: Perch): PerchConnection {
  const closers = new Set<() => void>();
  return {
    device: perch.device,
    publicKey: perch.identity.publicKey,
    via: "memory",
    capabilities: () => perch.capabilities(),
    classify: async (c, t, a) => perch.classify(c, t, a),
    invoke: (req) => perch.invoke(req),
    cancel: (id) => perch.cancel(id),
    onCapabilitiesChanged: (fn) => perch.onCapabilitiesChanged(fn),
    onClose: (fn) => {
      closers.add(fn);
      return () => closers.delete(fn);
    },
    close: () => {
      for (const fn of closers) fn();
      closers.clear();
    },
  };
}
