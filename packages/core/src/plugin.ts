/**
 * Plugin contract. Everything beyond the core — capabilities, links, surfaces, policies — is a plugin with this shape.
 * Built-in trusted plugins run in-process (cheap on phones and small boards); third-party isolation comes later (design §5.4).
 */
import { PLUGIN_API_VERSION, type CapabilityManifestInput, type Risk } from "@swiftnest/protocol";
import { SwiftnestFailure } from "./errors.js";
import type { Logger } from "./log.js";
import type { Nest } from "./nest.js";

export type PluginKind = "capability" | "link" | "surface" | "policy" | "router" | "store" | "panel";
export type PluginRole = "nest" | "perch";

export interface InvokeContext {
  taskId: string;
  /** Aborted on timeout or cancellation; long-running tools must honour it. */
  signal: AbortSignal;
  logger: Logger;
}

/** What a tool returns: plain text, or text plus structured data. Mark outside-world content `untrusted`. */
export type ToolOutput = string | { text?: string; data?: unknown; untrusted?: boolean };

/** A set of tools on a device. Usually wraps an existing MCP server or a few lines of code. */
export interface Capability {
  manifest: CapabilityManifestInput;
  /** Argument-level risk: e.g. `ls` is a read, `rm -rf` is sensitive. Defaults to the tool's declared risk. */
  classify?(tool: string, args: Record<string, unknown>): { risk: Risk; reason?: string } | undefined;
  invoke(tool: string, args: Record<string, unknown>, ctx: InvokeContext): Promise<ToolOutput>;
  dispose?(): void | Promise<void>;
}

export interface PerchPluginContext {
  role: "perch";
  device: string;
  logger: Logger;
  config: Record<string, unknown>;
  provideCapability(capability: Capability): void;
}

export interface NestPluginContext {
  role: "nest";
  nest: Nest;
  logger: Logger;
  config: Record<string, unknown>;
}

export type PluginContext = PerchPluginContext | NestPluginContext;
export type Disposer = () => void | Promise<void>;

export interface SwiftnestPlugin {
  /** npm package name, e.g. "@swiftnest/cap-shell". */
  name: string;
  kind: PluginKind;
  apiVersion: number;
  runsOn: PluginRole | "both";
  setup(ctx: PluginContext): void | Disposer | Promise<void | Disposer>;
}

/** Identity function that gives plugin authors type checking. */
export function definePlugin<P extends SwiftnestPlugin>(plugin: P): P {
  return plugin;
}

export class PluginHost {
  private disposers: { name: string; dispose: Disposer }[] = [];
  readonly loaded: SwiftnestPlugin[] = [];

  constructor(
    readonly role: PluginRole,
    private logger: Logger,
  ) {}

  async load(plugin: SwiftnestPlugin, ctx: PluginContext): Promise<void> {
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      throw new SwiftnestFailure(
        "PLUGIN_API_MISMATCH",
        `Plugin ${plugin.name} targets plugin API v${plugin.apiVersion}, this Swiftnest speaks v${PLUGIN_API_VERSION}.`,
        "Upgrade the plugin or Swiftnest so both use the same plugin API version.",
      );
    }
    if (plugin.runsOn !== "both" && plugin.runsOn !== this.role) {
      throw new SwiftnestFailure(
        "PLUGIN_WRONG_ROLE",
        `Plugin ${plugin.name} runs on the ${plugin.runsOn}, but this is a ${this.role}.`,
        plugin.runsOn === "perch" ? "Install it on the device (Perch) instead." : "Install it on the server (Nest) instead.",
      );
    }
    const dispose = await plugin.setup(ctx);
    this.loaded.push(plugin);
    if (dispose) this.disposers.push({ name: plugin.name, dispose });
    this.logger.debug(`loaded plugin ${plugin.name} (${plugin.kind})`);
  }

  async disposeAll(): Promise<void> {
    for (const { name, dispose } of this.disposers.reverse()) {
      try {
        await dispose();
      } catch (e) {
        this.logger.warn(`plugin ${name} failed to dispose`, e);
      }
    }
    this.disposers = [];
  }
}
