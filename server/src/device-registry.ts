/** Paired and online devices, their tools, and the metadata remembered while they are offline. */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fingerprintOf, text, type ExposedTool, type Nest } from '@swiftnest/core';
import type { Device } from '@swiftnest/api';
import type { Language } from './preferences.js';

type CachedDevice = Device & { tools?: ExposedTool[] };

/** The hub's own file store is a device internally, never one the owner sees. */
const INTERNAL_DEVICES = new Set(['server-files']);
/** Transfers have their own API; the model never calls them as tools. */
const HIDDEN_CAPABILITIES = new Set(['transfer']);

/** The name DSH sees: `device__<slug>__<area>_<tool>`. */
export function deviceToolName(slug: string, tool: ExposedTool): string {
  return `device__${slug}__${tool.capability}_${tool.tool.name}`;
}

/** E1 stored only capability and tool names. Until the next hello refreshes schemas and risk, offer callable placeholders. */
function offlinePlaceholders(device: CachedDevice): ExposedTool[] {
  return device.capabilities.flatMap((cap) =>
    cap.tools.map((name) => ({
      name: `${device.device}__${cap.id}__${name}`,
      device: device.device,
      capability: cap.id,
      tool: {
        name,
        description: `Device ${cap.id}.${name} (metadata refreshes on reconnect)`,
        risk: 'sensitive' as const,
        defaultTimeoutMs: 30_000,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      },
    })),
  );
}

function describe(tool: ExposedTool, lang: Language): string {
  const { description } = tool.tool;
  if (typeof description === 'string') return description;
  return lang === 'en' ? description.en : (description.zh ?? description.en);
}

export class DeviceRegistry {
  private previous = new Map<string, string>();
  private writes = Promise.resolve();

  private constructor(
    private readonly nest: Nest,
    private readonly file: string,
    private readonly lang: () => Language,
    private cached: Record<string, CachedDevice>,
  ) {
    this.previous = this.fingerprints();
  }

  static async open(nest: Nest, file: string, lang: () => Language): Promise<DeviceRegistry> {
    let cached: Record<string, CachedDevice> = {};
    try {
      cached = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const device of Object.values(cached)) {
      device.online = false;
      device.tools ??= offlinePlaceholders(device);
    }
    return new DeviceRegistry(nest, file, lang, cached);
  }

  /** Every paired or online device, live state first, then what was remembered. */
  list(): Device[] {
    const online = new Map(this.nest.devices().map((d) => [d.device, d]));
    const paired = new Map(this.nest.devicesStore.list().map((d) => [d.device, d]));
    const ids = [...new Set([...paired.keys(), ...online.keys()])].filter((id) => !INTERNAL_DEVICES.has(id));
    return ids.map((device) => {
      const live = online.get(device);
      const stored = paired.get(device);
      const remembered = this.cached[device];
      return {
        ...remembered,
        ...live,
        device,
        slug: stored?.slug,
        name: stored?.name ?? device,
        lastSeen: remembered?.lastSeen ?? stored?.pairedAt,
        kind: stored?.kind ?? 'desktop',
        online: !!live,
        paired: !!stored,
        fingerprint: live?.fingerprint ?? fingerprintOf(stored!.publicKey),
        pairedAt: stored?.pairedAt,
        capabilities: live?.capabilities ?? remembered?.capabilities ?? [],
      };
    });
  }

  /** What DSH sees: paired devices and their tools, in the owner's language. */
  snapshot() {
    const paired = this.list().filter((d) => d.paired);
    return {
      devices: paired.map((d) => ({
        slug: d.slug!,
        name: d.name!,
        kind: d.kind!,
        online: d.online,
        ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}),
      })),
      tools: paired.flatMap((d) =>
        this.tools(d.device).map((t) => ({
          name: deviceToolName(d.slug!, t),
          slug: d.slug!,
          description: describe(t, this.lang()),
          risk: t.tool.risk,
          inputSchema: t.tool.inputSchema,
        })),
      ),
    };
  }

  /** The device and raw tool behind a DSH tool name, if any. */
  resolve(name: string): { device: Device; tool: ExposedTool } | undefined {
    for (const device of this.list().filter((d) => d.paired)) {
      const tool = this.tools(device.device).find((t) => deviceToolName(device.slug!, t) === name);
      if (tool) return { device, tool };
    }
    return undefined;
  }

  /** Merge live tools into the remembered ones, persist, and return the slugs whose summary changed. */
  refresh(): string[] {
    const now = new Date().toISOString();
    const live = new Set(this.nest.devices().map((d) => d.device));
    const liveTools = this.nest.tools();
    const next: Record<string, CachedDevice> = Object.create(null);
    for (const d of this.list().filter((d) => d.paired || d.online)) {
      const tools = new Map((this.cached[d.device]?.tools ?? []).map((t) => [t.name, t]));
      for (const t of liveTools.filter((t) => t.device === d.device)) tools.set(t.name, t);
      const seen = live.has(d.device) || this.cached[d.device]?.online;
      next[d.device] = { ...d, tools: [...tools.values()], lastSeen: seen ? now : d.lastSeen };
    }
    this.cached = next;
    this.persist(JSON.stringify(next));
    const current = this.fingerprints();
    const slugs = [...new Set([...this.previous.keys(), ...current.keys()])].filter(
      (slug) => this.previous.get(slug) !== current.get(slug),
    );
    this.previous = current;
    return slugs;
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private tools(device: string): ExposedTool[] {
    return (this.cached[device]?.tools ?? []).filter((t) => !HIDDEN_CAPABILITIES.has(t.capability));
  }

  private fingerprints(): Map<string, string> {
    return new Map(this.snapshot().devices.map((d) => [d.slug, JSON.stringify(d)]));
  }

  private persist(data: string): void {
    this.writes = this.writes
      .then(async () => {
        await writeFile(`${this.file}.tmp`, data, { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      })
      .catch((error) => this.nest.logger.error(text('deviceMetadataWriteFailedLog'), error));
  }
}
