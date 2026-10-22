/**
 * Permission decisions. The core asks the policy before every tool call; the default policy is a plugin-replaceable
 * rule list over (client, device, capability, tool, risk). Argument-level judgement comes from the capability's
 * `classify` (e.g. cap-shell rating `ls` as a read and `rm` as sensitive) and arrives here as the call's risk.
 *
 * Sensitive operations are never decided by the agent: they default to "ask" and need a person.
 */
import type { ClientRef, Risk } from "@swiftnest/protocol";

export type Action = "allow" | "ask" | "deny";

export interface PolicyInput {
  client: ClientRef;
  device: string;
  capability: string;
  tool: string;
  args: Record<string, unknown>;
  risk: Risk;
  /** The capability's explanation of the risk, if any. */
  reason?: string;
}

export interface Decision {
  action: Action;
  reason: string;
}

export interface Policy {
  decide(input: PolicyInput): Decision | Promise<Decision>;
}

export interface PolicyRule {
  client?: string;
  device?: string;
  capability?: string;
  tool?: string;
  risk?: Risk;
  action: Action;
  note?: string;
}

/** Safe defaults: observing is fine, anything that changes or runs things asks a person. */
export const DEFAULT_RISK_ACTIONS: Record<Risk, Action> = { read: "allow", write: "ask", exec: "ask", sensitive: "ask" };

export class RulePolicy implements Policy {
  constructor(
    private rules: PolicyRule[] = [],
    private defaults: Record<Risk, Action> = DEFAULT_RISK_ACTIONS,
  ) {}

  decide(i: PolicyInput): Decision {
    const rule = this.rules.find(
      (r) =>
        (!r.client || r.client === i.client.id) &&
        (!r.device || r.device === i.device) &&
        (!r.capability || r.capability === i.capability) &&
        (!r.tool || r.tool === i.tool) &&
        (!r.risk || r.risk === i.risk),
    );
    // Rules may tighten anything, but may not silently auto-allow a sensitive call.
    if (rule && !(i.risk === "sensitive" && rule.action === "allow")) {
      return { action: rule.action, reason: rule.note ?? `rule: ${describe(rule)}` };
    }
    const why = i.reason ? `${i.risk} (${i.reason})` : i.risk;
    return { action: this.defaults[i.risk], reason: `default for ${why}` };
  }
}

function describe(r: PolicyRule): string {
  return [r.client && `client=${r.client}`, r.device && `device=${r.device}`, r.capability && `capability=${r.capability}`, r.tool && `tool=${r.tool}`, r.risk && `risk=${r.risk}`]
    .filter(Boolean)
    .join(" ") || "any";
}
