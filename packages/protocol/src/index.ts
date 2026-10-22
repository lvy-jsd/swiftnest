/**
 * @swiftnest/protocol — the data shapes every Swiftnest component agrees on.
 *
 * Kept dependency-light (zod only) so plugins, the Nest, Perches and clients can all share it.
 * Bump PROTOCOL_VERSION on any breaking change; peers negotiate it on connect.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
/** Plugin API version a plugin declares in its manifest (`swiftnest.apiVersion`). */
export const PLUGIN_API_VERSION = 1;

// ---------------------------------------------------------------- localized text

/** A string, or the same text per language. UIs pick the viewer's language and fall back to English. */
export const LocalizedText = z.union([z.string(), z.object({ en: z.string(), zh: z.string().optional() })]);
export type LocalizedText = z.infer<typeof LocalizedText>;

export function localize(text: LocalizedText, lang: "en" | "zh" = "en"): string {
  if (typeof text === "string") return text;
  return (lang === "zh" ? text.zh : undefined) ?? text.en;
}

// ---------------------------------------------------------------- names

/** Device, capability and tool names: lowercase letters, digits, single dashes. */
export const Name = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "use 1–32 lowercase letters, digits or dashes, starting with a letter");

/**
 * Tool names exposed to agents are `<device>__<capability>__<tool>`.
 * Double underscores, not dots: OpenAI / Anthropic function names only allow [A-Za-z0-9_-].
 */
export const TOOL_SEPARATOR = "__";

export function qualifiedToolName(device: string, capability: string, tool: string): string {
  return [device, capability, tool].join(TOOL_SEPARATOR);
}

export function parseQualifiedToolName(name: string): { device: string; capability: string; tool: string } | null {
  const parts = name.split(TOOL_SEPARATOR);
  if (parts.length !== 3 || parts.some((p) => !Name.safeParse(p).success)) return null;
  const [device, capability, tool] = parts as [string, string, string];
  return { device, capability, tool };
}

// ---------------------------------------------------------------- capabilities and tools

/**
 * How dangerous a tool call is, before argument-level policy refines it.
 * read: observes only · write: changes local state · exec: runs code · sensitive: money, deletion, outbound messages.
 */
export const Risk = z.enum(["read", "write", "exec", "sensitive"]);
export type Risk = z.infer<typeof Risk>;

export const ToolDescriptor = z.object({
  name: Name,
  title: LocalizedText.optional(),
  description: LocalizedText,
  /** JSON Schema of the arguments object. */
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
  /** Default risk; a capability may raise or lower it per call via `classify`. */
  risk: Risk,
  /** Soft timeout applied when the caller gives none. */
  defaultTimeoutMs: z.number().int().positive().max(3_600_000).default(30_000),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;
export type ToolDescriptorInput = z.input<typeof ToolDescriptor>;

export const CapabilityManifest = z.object({
  /** Stable id, unique on its device, e.g. "shell". */
  id: Name,
  version: z.string().default("0.0.0"),
  title: LocalizedText,
  description: LocalizedText.optional(),
  /** Capability-level permissions this capability needs, e.g. ["process.spawn"]. */
  permissions: z.array(z.string()).default([]),
  tools: z.array(ToolDescriptor).min(1),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;
export type CapabilityManifestInput = z.input<typeof CapabilityManifest>;

// ---------------------------------------------------------------- tasks

export const TaskState = z.enum([
  "queued",
  "pending_approval",
  "running",
  "succeeded",
  "failed",
  "denied",
  "timed_out",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["succeeded", "failed", "denied", "timed_out", "cancelled"]);

/** Who asked: the agent / client that issued the call (Claude Desktop, DSH, a test…). */
export const ClientRef = z.object({ id: z.string(), name: z.string().optional() });
export type ClientRef = z.infer<typeof ClientRef>;

/** Uniform error: what went wrong, how to fix it, and whether retrying can help. */
export const SwiftnestError = z.object({
  code: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  retryable: z.boolean().default(false),
});
export type SwiftnestError = z.infer<typeof SwiftnestError>;

/** What a tool returns. `untrusted` marks content that came from the outside world (web, mail, files). */
export const ToolResult = z.object({
  text: z.string().default(""),
  data: z.unknown().optional(),
  untrusted: z.boolean().default(false),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const TaskSnapshot = z.object({
  id: z.string(),
  device: Name,
  capability: Name,
  tool: Name,
  args: z.record(z.string(), z.unknown()),
  client: ClientRef,
  state: TaskState,
  risk: Risk,
  /** Why the policy decided what it did (shown in approvals and the audit log). */
  reason: z.string().optional(),
  result: ToolResult.optional(),
  error: SwiftnestError.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshot>;

// ---------------------------------------------------------------- audit

export const AuditEntry = z.object({
  at: z.string(),
  taskId: z.string(),
  client: ClientRef,
  device: z.string(),
  capability: z.string(),
  tool: z.string(),
  /** Arguments as given, so approvals and reviews see the raw call, not a model's summary. */
  args: z.record(z.string(), z.unknown()),
  state: TaskState,
  reason: z.string().optional(),
  error: SwiftnestError.optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ---------------------------------------------------------------- Nest ⇄ Perch messages (carried by link plugins)

export const PerchHello = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  device: Name,
  publicKey: z.string(),
  capabilities: z.array(CapabilityManifest),
});
export const InvokeRequest = z.object({
  type: z.literal("invoke"),
  taskId: z.string(),
  capability: Name,
  tool: Name,
  args: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive(),
});
export const InvokeResult = z.object({
  type: z.literal("result"),
  taskId: z.string(),
  ok: z.boolean(),
  result: ToolResult.optional(),
  error: SwiftnestError.optional(),
});
export const CancelRequest = z.object({ type: z.literal("cancel"), taskId: z.string() });
/** Ask the Perch's capability how risky this particular call is (argument-level classification). */
export const ClassifyRequest = z.object({
  type: z.literal("classify"),
  requestId: z.string(),
  capability: Name,
  tool: Name,
  args: z.record(z.string(), z.unknown()),
});
export const ClassifyResult = z.object({
  type: z.literal("classified"),
  requestId: z.string(),
  risk: Risk,
  reason: z.string().optional(),
});
/** The Perch's capabilities changed (a plugin was added or removed). */
export const CapabilitiesUpdate = z.object({ type: z.literal("capabilities"), capabilities: z.array(CapabilityManifest) });
/** The Nest accepted the hello: the device is online. */
export const Welcome = z.object({ type: z.literal("welcome") });
/** Either side ends the session on purpose (revoked, shutting down, refused); `code` says why. */
export const Bye = z.object({ type: z.literal("bye"), code: z.string(), message: z.string() });

// Pairing runs inside the encrypted channel (design §7.2): the code proves the owner allowed it, the fingerprints both
// people compare prove nobody sits in between.
/** Perch → Nest: HMAC-SHA-256(code, "swiftnest/pair/v1" ‖ transcript hash), never the code itself. */
export const PairRequest = z.object({ type: z.literal("pair"), proof: z.string() });
/** Nest → Perch: the code was right (now compare fingerprints), pairing finished, or refused. */
export const PairStatus = z.object({
  type: z.literal("pair_status"),
  status: z.enum(["code_ok", "paired", "rejected"]),
  message: z.string().optional(),
});
/** Perch → Nest: the person at the device says the Nest fingerprint matches (or not). */
export const PairConfirm = z.object({ type: z.literal("pair_confirm"), accept: z.boolean() });

export const LinkMessage = z.discriminatedUnion("type", [
  PerchHello,
  InvokeRequest,
  InvokeResult,
  CancelRequest,
  ClassifyRequest,
  ClassifyResult,
  CapabilitiesUpdate,
  Welcome,
  Bye,
  PairRequest,
  PairStatus,
  PairConfirm,
]);
export type LinkMessage = z.infer<typeof LinkMessage>;
