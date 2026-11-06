import { type MessageKey, type Text, text } from './language.js';
export * from './language.js';
/**
 * @swiftnest/protocol — the data shapes every Swiftnest component agrees on.
 *
 * Kept dependency-light (zod only) so plugins, the Nest, Perches and clients can all share it.
 * Bump PROTOCOL_VERSION on any breaking change; peers negotiate it on connect.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
/** Plugin API version a plugin declares in its manifest (`swiftnest.apiVersion`). */
export const PLUGIN_API_VERSION = 1;

// ---------------------------------------------------------------- localized text

/** A string, or the same text per language. UIs pick the viewer's language and fall back to English. */
export const LocalizedText = z.union([z.string(), z.object({ en: z.string(), zh: z.string().optional() })]);
export type LocalizedText = z.infer<typeof LocalizedText>;

export function localize(text: LocalizedText, lang: 'en' | 'zh' = 'zh'): string {
  if (typeof text === 'string') return text;
  return (lang === 'zh' ? text.zh : undefined) ?? text.en;
}

// ---------------------------------------------------------------- names

/** Device, capability and tool names: lowercase letters, digits, single dashes. */
export const Name = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'use 1–32 lowercase letters, digits or dashes, starting with a letter');

/** Tool components may include single underscores; double underscores delimit qualified names. */
export const ToolName = z.string().regex(/^[a-z](?!.*__)[a-z0-9_-]{0,31}$/);

/**
 * Tool names exposed to agents are `<device>__<capability>__<tool>`.
 * Double underscores, not dots: OpenAI / Anthropic function names only allow [A-Za-z0-9_-].
 */
export const TOOL_SEPARATOR = '__';

export function qualifiedToolName(device: string, capability: string, tool: string): string {
  return [device, capability, tool].join(TOOL_SEPARATOR);
}

export function parseQualifiedToolName(name: string): { device: string; capability: string; tool: string } | null {
  const parts = name.split(TOOL_SEPARATOR);
  if (
    parts.length !== 3 ||
    parts.some((p, i) => !(i === 2 ? ToolName.safeParse(p).success : Name.safeParse(p).success))
  )
    return null;
  const [device, capability, tool] = parts as [string, string, string];
  return { device, capability, tool };
}

// ---------------------------------------------------------------- capabilities and tools

/**
 * How dangerous a tool call is, before argument-level policy refines it.
 * read: observes only · write: changes local state · exec: runs code · sensitive: money, deletion, outbound messages.
 */
export const Risk = z.enum(['read', 'write', 'exec', 'sensitive']);
export type Risk = z.infer<typeof Risk>;

const RISK_KEYS: Record<Risk, MessageKey> = {
  read: 'policyRead',
  write: 'policyWrite',
  exec: 'policyExec',
  sensitive: 'policySensitive',
};
/** A risk level as catalog text, for showing it to a person. */
export const riskText = (risk: Risk): Text => text(RISK_KEYS[risk]);

export const ToolDescriptor = z.object({
  name: ToolName,
  title: LocalizedText.optional(),
  description: LocalizedText,
  /** JSON Schema of the arguments object. */
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
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
  version: z.string().default('0.0.0'),
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
  'queued',
  'pending_approval',
  'running',
  'succeeded',
  'failed',
  'denied',
  'timed_out',
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskState>;

const STATE_KEYS: Record<TaskState, MessageKey> = {
  queued: 'stateQueued',
  pending_approval: 'statePending',
  running: 'stateRunning',
  succeeded: 'stateSucceeded',
  failed: 'stateFailed',
  denied: 'stateDenied',
  timed_out: 'stateTimedOut',
  cancelled: 'stateCancelled',
};
/** A task state as catalog text, for showing it to a person. */
export const stateText = (state: TaskState): Text => text(STATE_KEYS[state]);

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'succeeded',
  'failed',
  'denied',
  'timed_out',
  'cancelled',
]);

/** Who asked: the agent / client that issued the call (Claude Desktop, DSH, a test…). */
export const ClientRef = z.object({ id: z.string(), name: z.string().optional() });
export type ClientRef = z.infer<typeof ClientRef>;

/**
 * Catalog text on the wire. Keys are not checked here: a newer peer may send keys this build
 * lacks, and readers then fall back to the English `message` beside it.
 */
export const WireText: z.ZodType<{ key: string; args?: unknown[] }> = z.lazy(() =>
  z.object({ key: z.string(), args: z.array(z.union([z.string(), z.number(), WireText])).optional() }),
);

/**
 * Uniform error: what went wrong, how to fix it, and whether retrying can help. `message` and
 * `hint` are English for logs and models; `text` and `hintText` let each reader localize.
 */
export const SwiftnestError = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  suggestion: z.string().optional(),
  text: WireText.optional(),
  hintText: WireText.optional(),
  retryable: z.boolean().default(false),
});
export type SwiftnestError = z.infer<typeof SwiftnestError>;

/** What a tool returns. `untrusted` marks content that came from the outside world (web, mail, files). */
export const ToolResult = z.object({
  text: z.string().default(''),
  data: z.unknown().optional(),
  untrusted: z.boolean().default(false),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const TaskSnapshot = z.object({
  id: z.string(),
  device: Name,
  capability: Name,
  tool: ToolName,
  args: z.record(z.string(), z.unknown()),
  client: ClientRef,
  state: TaskState,
  risk: Risk,
  /** Why the policy decided what it did (shown in approvals and the audit log), in English. */
  reason: z.string().optional(),
  /** The same reason as catalog text, so each reader can localize it. */
  reasonText: WireText.optional(),
  result: ToolResult.optional(),
  error: SwiftnestError.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshot>;

// ---------------------------------------------------------------- audit

export const AuditEntry = z.object({
  approval: z
    .object({
      kind: z.enum(['dsh', 'device', 'transfer']),
      state: z.enum(['pending', 'allowed', 'denied', 'expired']),
      answeredBy: z.string(),
      answeringDevice: z.string(),
      automatic: z.boolean(),
    })
    .optional(),
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
  reasonText: WireText.optional(),
  error: SwiftnestError.optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ---------------------------------------------------------------- Nest ⇄ Perch messages (carried by link plugins)

export const PerchHello = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  device: Name,
  publicKey: z.string(),
  kind: z.enum(['desktop', 'android']).optional(),
  /** Human-readable label; the protocol device identity and agent slug stay stable. */
  name: z.string().min(1).max(128).optional(),
  extensions: z.array(z.string()).optional(),
  capabilities: z.array(CapabilityManifest),
});
export const InvokeRequest = z.object({
  type: z.literal('invoke'),
  taskId: z.string(),
  capability: Name,
  tool: ToolName,
  args: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive(),
});
export const InvokeResult = z.object({
  type: z.literal('result'),
  taskId: z.string(),
  ok: z.boolean(),
  result: ToolResult.optional(),
  error: SwiftnestError.optional(),
});
export const CancelRequest = z.object({ type: z.literal('cancel'), taskId: z.string() });
/** Ask the Perch's capability how risky this particular call is (argument-level classification). */
export const ClassifyRequest = z.object({
  type: z.literal('classify'),
  requestId: z.string(),
  capability: Name,
  tool: ToolName,
  args: z.record(z.string(), z.unknown()),
});
export const ClassifyResult = z.object({
  type: z.literal('classified'),
  requestId: z.string(),
  risk: Risk,
  reason: z.string().optional(),
  reasonText: WireText.optional(),
  /**
   * The capability states that this call cannot succeed at all (a path outside the folders the device
   * shares, a protected location). The policy denies it instead of asking the owner to approve a call
   * that would fail right after approval. Absent means "just a rating".
   */
  refused: z.boolean().optional(),
  /** What to do about it, from the capability that refused: better than a generic "ask the owner". */
  hint: z.string().optional(),
  hintText: WireText.optional(),
});
/** The Perch's capabilities changed (a plugin was added or removed). */
export const CapabilitiesUpdate = z.object({
  type: z.literal('capabilities'),
  capabilities: z.array(CapabilityManifest),
});
/** The Nest accepted the hello: the device is online. */
export const Welcome = z.object({ type: z.literal('welcome') });
/** Either side ends the session on purpose (revoked, shutting down, refused); `code` says why. */
export const Bye = z.object({ type: z.literal('bye'), code: z.string(), message: z.string() });

// Pairing runs inside the encrypted channel (design §7.2): the code proves the owner allowed it, the fingerprints both
// people compare prove nobody sits in between.
/** Perch → Nest: HMAC-SHA-256(code, "swiftnest/pair/v1" ‖ transcript hash), never the code itself. */
export const PairRequest = z.object({ type: z.literal('pair'), proof: z.string() });
/** Nest → Perch: the code was right (now compare fingerprints), pairing finished, or refused. */
export const PairStatus = z.object({
  type: z.literal('pair_status'),
  status: z.enum(['code_ok', 'paired', 'rejected']),
  message: z.string().optional(),
});
/** Perch → Nest: the person at the device says the Nest fingerprint matches (or not). */
export const PairConfirm = z.object({ type: z.literal('pair_confirm'), accept: z.boolean() });

export const StreamOpen = z.object({
  type: z.literal('stream_open'),
  id: z.string().regex(/^[a-f0-9]{32}$/),
  purpose: z.enum(['screen', 'file']),
  direction: z.literal('duplex'),
  transportCandidates: z.tuple([z.literal('websocket-relay-v1')]),
  ticket: z.string().max(128),
  expires: z.number(),
  maxFrame: z.number().int().min(1024).max(4194304),
  maxDimension: z.number().int().min(320).max(2560),
  displayId: z.string().max(128),
  file: z
    .object({
      binding: z.object({
        source: z.string(),
        destination: z.string(),
        sourcePath: z.string(),
        destinationPath: z.string(),
        meta: z.object({
          size: z.number().int().nonnegative().safe(),
          mtime: z.number().int().nonnegative().safe(),
          prefix: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      }),
      sender: z.boolean(),
      key: z.string(),
      cipherId: z.string().regex(/^[a-f0-9]{32}$/),
      candidates: z.array(z.string()).max(3),
      directTicket: z.string(),
      listen: z.boolean(),
    })
    .optional(),
});
export const StreamAccept = z.object({
  type: z.literal('stream_accept'),
  id: z.string(),
  candidates: z.array(z.string().max(256)).max(3).optional(),
});
export const StreamClose = z.object({ type: z.literal('stream_close'), id: z.string(), reason: z.string().max(256) });
export const LinkMessage = z.discriminatedUnion('type', [
  PerchHello,
  StreamOpen,
  StreamAccept,
  StreamClose,
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

export type * from './memory.js';

export * from './native-pairing.js';

export * from './chat-search.js';

export * from './approvals.js';
