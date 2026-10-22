/**
 * mDNS (DNS-SD) for `_swiftnest._tcp.local`: the Nest answers, devices ask. Discovery is only a hint for where to
 * connect — the handshake still checks the Nest's key, so a fake answer can at worst waste a connection attempt.
 */
import { hostname, networkInterfaces } from "node:os";
import makeMdns from "multicast-dns";

export const SERVICE = "_swiftnest._tcp.local";

export interface DiscoveredNest {
  /** ws://address:port/path */
  url: string;
  /** Nest fingerprint from the TXT record (unverified until the handshake). */
  fingerprint: string;
  instance: string;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/** Answer queries for the service until `stop()` is called. */
export function advertise(o: { port: number; path: string; fingerprint: string }): { stop(): void } {
  const mdns = makeMdns();
  const host = `${hostname().replace(/\.local$/, "")}.local`;
  const instance = `swiftnest-${o.fingerprint.slice(0, 9)}.${SERVICE}`;
  const records = () => [
    { name: instance, type: "SRV" as const, ttl: 120, data: { port: o.port, target: host, priority: 0, weight: 0 } },
    { name: instance, type: "TXT" as const, ttl: 120, data: [`fp=${o.fingerprint}`, `path=${o.path}`, "v=1"] },
    ...lanAddresses().map((ip) => ({ name: host, type: "A" as const, ttl: 120, data: ip })),
  ];
  mdns.on("query", (query) => {
    const asked = query.questions.some((q) => (q.name === SERVICE && (q.type === "PTR" || (q.type as string) === "ANY")) || q.name === instance);
    if (!asked) return;
    mdns.respond({ answers: [{ name: SERVICE, type: "PTR", ttl: 120, data: instance }], additionals: records() });
  });
  return { stop: () => mdns.destroy() };
}

/** Ask the network for Nests; collects answers for `timeoutMs`. */
export function discover(timeoutMs = 2_000): Promise<DiscoveredNest[]> {
  return new Promise((resolve) => {
    const mdns = makeMdns();
    const found = new Map<string, DiscoveredNest>();
    mdns.on("response", (response, rinfo) => {
      const all = [...response.answers, ...(response.additionals ?? [])];
      for (const ptr of all) {
        if (ptr.type !== "PTR" || ptr.name !== SERVICE) continue;
        const instance = String((ptr as { data: unknown }).data);
        const srv = all.find((r) => r.type === "SRV" && r.name === instance);
        const txt = all.find((r) => r.type === "TXT" && r.name === instance);
        if (!srv || srv.type !== "SRV") continue;
        const fields = new Map<string, string>();
        for (const entry of ((txt as { data?: unknown } | undefined)?.data as (Buffer | string)[] | undefined) ?? []) {
          const [k, ...v] = String(entry).split("=");
          fields.set(k!, v.join("="));
        }
        // The address the answer came from is the most reliable one to dial on a LAN.
        const url = `ws://${rinfo.address}:${srv.data.port}${fields.get("path") ?? "/swiftnest"}`;
        found.set(instance, { url, fingerprint: fields.get("fp") ?? "", instance });
      }
    });
    mdns.query({ questions: [{ name: SERVICE, type: "PTR" }] });
    setTimeout(() => {
      mdns.destroy();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
