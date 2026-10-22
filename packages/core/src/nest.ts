/**
 * Nest (巢): the server every device connects to. It keeps the registry of connected devices and their capabilities,
 * routes tool calls through policy → approval → device, and writes the audit log. Surfaces (MCP endpoint, web panel,
 * DSH…) are plugins that talk to this class.
 */
import { EventEmitter } from "node:events";
import { parseQualifiedToolName, qualifiedToolName, type ClientRef, type ToolDescriptor } from "@swiftnest/protocol";
import { MemoryAuditLog, type AuditLog } from "./audit.js";
import { SwiftnestFailure } from "./errors.js";
import { fingerprintOf, generateIdentity, type Identity } from "./identity.js";
import type { PerchConnection } from "./link.js";
import { createLogger, type Logger } from "./log.js";
import { MemoryDeviceStore, PairingManager, type DeviceStore } from "./pairing.js";
import { PluginHost, type SwiftnestPlugin } from "./plugin.js";
import { RulePolicy, type Policy } from "./policy.js";
import { TaskManager } from "./tasks.js";

export interface NestOptions {
  identity?: Identity;
  audit?: AuditLog;
  policy?: Policy;
  logger?: Logger;
  approvalTimeoutMs?: number;
  maxConcurrentPerDevice?: number;
  /** Paired devices (remote links only accept these). Defaults to an in-memory list. */
  devices?: DeviceStore;
  pairing?: PairingManager;
}

export interface ExposedTool {
  /** `<device>__<capability>__<tool>` */
  name: string;
  device: string;
  capability: string;
  tool: ToolDescriptor;
}

export interface DeviceInfo {
  device: string;
  fingerprint: string;
  via: string;
  capabilities: { id: string; version: string; tools: string[] }[];
}

export class Nest {
  readonly identity: Identity;
  readonly audit: AuditLog;
  readonly policy: Policy;
  readonly tasks: TaskManager;
  readonly logger: Logger;
  readonly devicesStore: DeviceStore;
  readonly pairing: PairingManager;
  private host: PluginHost;
  private conns = new Map<string, { conn: PerchConnection; off: (() => void)[] }>();
  private events = new EventEmitter();

  constructor(opts: NestOptions = {}) {
    this.identity = opts.identity ?? generateIdentity();
    this.audit = opts.audit ?? new MemoryAuditLog();
    this.policy = opts.policy ?? new RulePolicy();
    this.logger = opts.logger ?? createLogger("nest");
    this.devicesStore = opts.devices ?? new MemoryDeviceStore();
    this.pairing = opts.pairing ?? new PairingManager();
    this.host = new PluginHost("nest", this.logger);
    this.tasks = new TaskManager({
      connection: (d) => this.conns.get(d)?.conn,
      defaultTimeout: (d, c, t) => this.findTool(d, c, t)?.defaultTimeoutMs,
      policy: this.policy,
      audit: this.audit,
      logger: this.logger.child("tasks"),
      approvalTimeoutMs: opts.approvalTimeoutMs,
      maxConcurrentPerDevice: opts.maxConcurrentPerDevice,
    });
  }

  async use(plugin: SwiftnestPlugin, config: Record<string, unknown> = {}): Promise<this> {
    await this.host.load(plugin, { role: "nest", nest: this, logger: this.logger.child(plugin.name), config });
    return this;
  }

  /** Called by link plugins when a paired device comes online. */
  attach(conn: PerchConnection): void {
    const existing = this.conns.get(conn.device);
    if (existing && existing.conn.publicKey !== conn.publicKey) {
      throw new SwiftnestFailure(
        "DEVICE_NAME_TAKEN",
        `Another device is already registered as "${conn.device}".`,
        "Give the new device a different name, or remove the old one first.",
      );
    }
    existing?.off.forEach((f) => f());
    const off = [conn.onCapabilitiesChanged(() => this.changed()), conn.onClose(() => this.detach(conn.device, conn))];
    this.conns.set(conn.device, { conn, off });
    this.logger.info(`device online: ${conn.device} via ${conn.via} (${fingerprintOf(conn.publicKey)})`);
    this.changed();
  }

  detach(device: string, conn?: PerchConnection): void {
    const entry = this.conns.get(device);
    if (!entry || (conn && entry.conn !== conn)) return;
    entry.off.forEach((f) => f());
    this.conns.delete(device);
    this.logger.info(`device offline: ${device}`);
    this.changed();
  }

  /**
   * Remove a paired device: it is disconnected now (told why) and can only come back by pairing again.
   * Returns false when the device was neither paired nor online.
   */
  async revoke(device: string): Promise<boolean> {
    const removed = await this.devicesStore.remove(device);
    const entry = this.conns.get(device);
    entry?.conn.close("REVOKED", "This device was revoked on the Nest.");
    this.detach(device);
    if (removed || entry) this.logger.info(`revoked ${device}`);
    return removed || Boolean(entry);
  }

  devices(): DeviceInfo[] {
    return [...this.conns.values()].map(({ conn }) => ({
      device: conn.device,
      fingerprint: fingerprintOf(conn.publicKey),
      via: conn.via,
      capabilities: conn.capabilities().map((c) => ({ id: c.id, version: c.version, tools: c.tools.map((t) => t.name) })),
    }));
  }

  /** Every tool of every online device, named for agents. */
  tools(): ExposedTool[] {
    const out: ExposedTool[] = [];
    for (const { conn } of this.conns.values()) {
      for (const cap of conn.capabilities()) {
        for (const tool of cap.tools) out.push({ name: qualifiedToolName(conn.device, cap.id, tool.name), device: conn.device, capability: cap.id, tool });
      }
    }
    return out;
  }

  /** Call a tool by its exposed name. Returns the task right after the policy decision. */
  call(name: string, args: Record<string, unknown>, client: ClientRef, timeoutMs?: number) {
    const parts = parseQualifiedToolName(name);
    if (!parts) {
      throw new SwiftnestFailure("BAD_TOOL_NAME", `"${name}" is not a Swiftnest tool name.`, "Tool names look like <device>__<capability>__<tool>, e.g. laptop__shell__run.");
    }
    return this.tasks.submit({ client, ...parts, args, timeoutMs });
  }

  /** Fires whenever the set of devices or tools changes (MCP surfaces send tools/list_changed). */
  onToolsChanged(fn: () => void): () => void {
    this.events.on("tools", fn);
    return () => this.events.off("tools", fn);
  }

  async close(): Promise<void> {
    for (const [device, { conn }] of this.conns) {
      conn.close();
      this.detach(device);
    }
    await this.host.disposeAll();
  }

  private findTool(device: string, capability: string, tool: string): ToolDescriptor | undefined {
    return this.conns.get(device)?.conn.capabilities().find((c) => c.id === capability)?.tools.find((t) => t.name === tool);
  }

  private changed() {
    this.events.emit("tools");
  }
}
