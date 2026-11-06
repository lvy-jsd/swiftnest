/**
 * Perch (栖点): the program on each controlled device. Hosts capability plugins and executes tool calls the Nest
 * sends over a link, with timeouts and cancellation enforced here, on the device.
 */
import {
  CapabilityManifest,
  PROTOCOL_VERSION,
  type InvokeRequest,
  type InvokeResult,
  type ToolResult,
  text,
} from '@swiftnest/protocol';
import type { z } from 'zod';
import { SwiftnestFailure } from './errors.js';
import { classification, type Classification } from './policy.js';
import { generateIdentity, type Identity } from './identity.js';
import { createLogger, type Logger } from './log.js';
import { PluginHost, type Capability, type SwiftnestPlugin, type ToolOutput } from './plugin.js';

export interface PerchOptions {
  /** Device name shown to agents as the first part of tool names, e.g. "laptop". */
  device: string;
  kind?: 'desktop' | 'android';
  identity?: Identity;
  logger?: Logger;
}

type Invoke = Omit<z.infer<typeof InvokeRequest>, 'type'>;
type Result = z.infer<typeof InvokeResult>;

export class Perch {
  readonly device: string;
  readonly kind: 'desktop' | 'android';
  readonly identity: Identity;
  readonly logger: Logger;
  private host: PluginHost;
  private caps = new Map<string, { impl: Capability; manifest: CapabilityManifest }>();
  private running = new Map<string, AbortController>();
  private listeners = new Set<() => void>();

  constructor(opts: PerchOptions) {
    this.device = opts.device;
    this.kind = opts.kind ?? 'desktop';
    this.identity = opts.identity ?? generateIdentity();
    this.logger = opts.logger ?? createLogger(`perch:${opts.device}`);
    this.host = new PluginHost('perch', this.logger);
  }

  /** Install a plugin on this device. */
  async use(plugin: SwiftnestPlugin, config: Record<string, unknown> = {}): Promise<this> {
    await this.host.load(plugin, {
      role: 'perch',
      device: this.device,
      logger: this.logger.child(plugin.name),
      config,
      provideCapability: (c) => this.addCapability(c),
    });
    return this;
  }

  addCapability(impl: Capability): void {
    const manifest = CapabilityManifest.parse(impl.manifest);
    if (this.caps.has(manifest.id)) {
      throw new SwiftnestFailure(
        'CAPABILITY_CONFLICT',
        text('capabilityAlreadyInstalled', manifest.id, this.device),
        text('hintResolveCapabilityConflict'),
      );
    }
    this.caps.set(manifest.id, { impl, manifest });
    for (const fn of this.listeners) fn();
  }

  capabilities(): CapabilityManifest[] {
    return [...this.caps.values()].map((c) => c.manifest);
  }

  hello() {
    return {
      type: 'hello' as const,
      protocol: PROTOCOL_VERSION,
      device: this.device,
      kind: this.kind,
      publicKey: this.identity.publicKey,
      capabilities: this.capabilities(),
    };
  }

  onCapabilitiesChanged(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private lookup(capability: string, tool: string) {
    const cap = this.caps.get(capability);
    const desc = cap?.manifest.tools.find((t) => t.name === tool);
    if (!cap || !desc) {
      throw new SwiftnestFailure(
        'UNKNOWN_TOOL',
        text('noTool', this.device, capability, tool),
        text('hintListToolsAgain'),
      );
    }
    return { cap, desc };
  }

  classify(capability: string, tool: string, args: Record<string, unknown>): Classification {
    const { cap, desc } = this.lookup(capability, tool);
    const rated = cap.impl.classify?.(tool, args);
    return rated ? classification(rated.risk, rated.reason, rated.refused, rated.hint) : { risk: desc.risk };
  }

  async invoke(req: Invoke): Promise<Result> {
    const fail = (e: unknown): Result => ({
      type: 'result',
      taskId: req.taskId,
      ok: false,
      error: SwiftnestFailure.from(e, 'TOOL_FAILED'),
    });
    let found: ReturnType<Perch['lookup']>;
    try {
      found = this.lookup(req.capability, req.tool);
    } catch (e) {
      return fail(e);
    }
    const ac = new AbortController();
    this.running.set(req.taskId, ac);
    const timer = setTimeout(
      () =>
        ac.abort(
          new SwiftnestFailure('TIMEOUT', text('timedOutAfterMs', req.timeoutMs), text('hintLongerTimeout'), true),
        ),
      req.timeoutMs,
    );
    try {
      const out = await Promise.race([
        found.cap.impl.invoke(req.tool, req.args, { taskId: req.taskId, signal: ac.signal, logger: this.logger }),
        new Promise<never>((_, reject) =>
          ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true }),
        ),
      ]);
      return { type: 'result', taskId: req.taskId, ok: true, result: normalize(out) };
    } catch (e) {
      return fail(ac.signal.aborted ? ac.signal.reason : e);
    } finally {
      clearTimeout(timer);
      this.running.delete(req.taskId);
    }
  }

  cancel(taskId: string): void {
    this.running.get(taskId)?.abort(new SwiftnestFailure('CANCELLED', text('cancelledRequest')));
  }

  async close(): Promise<void> {
    for (const ac of this.running.values())
      ac.abort(new SwiftnestFailure('CANCELLED', text('deviceShuttingDown'), undefined, true));
    for (const { impl } of this.caps.values()) await impl.dispose?.();
    await this.host.disposeAll();
    this.caps.clear();
  }
}

function normalize(out: ToolOutput): ToolResult {
  if (typeof out === 'string') return { text: out, untrusted: false };
  return { text: out.text ?? '', data: out.data, untrusted: out.untrusted ?? false };
}
