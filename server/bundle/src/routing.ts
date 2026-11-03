/**
 * Model routing: the main model stays in charge and hands hard tasks to the expert,
 * a DSH subagent pinned to a stronger model (the `ask_expert` tool the server's profile
 * declares). This module tells the main model when to hand off and, in the default
 * `ask` mode, holds every hand-off for the owner's approval, because the task leaves
 * this server and spends the owner's API credit.
 */
import { message } from '@swiftnest/protocol';

export const name = 'swiftnest-routing';
export const inject = ['systemPrompt'];

export interface RoutingConfig {
  /** The expert's tool name. */
  tool: string;
  /** The expert's model id, shown to the main model and in approval prompts. */
  model: string;
  approval: 'ask' | 'auto';
}

interface ToolCall {
  name: string;
}

type PreDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; [locale: string]: string } };

export interface RoutingContext {
  systemPrompt: {
    section(section: { name: string; order: number; interpolate: false; text(): string }): () => void;
  };
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolCall, next: () => Promise<PreDecision>) => Promise<PreDecision>,
  ): () => void;
  effect(fn: () => () => void, label?: string): void;
}

export function apply(ctx: RoutingContext, config: RoutingConfig) {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'swiftnest:routing',
        order: 640,
        interpolate: false,
        text: () => message('routingGuidance', undefined, [config.tool, config.model]),
      }),
    'swiftnest-routing: prompt',
  );
  if (config.approval !== 'ask') return;
  ctx.effect(
    () => ctx.on('tools/pre-execute', (exec, next) => (exec.name === config.tool ? askOwner(config) : next())),
    'swiftnest-routing: approval',
  );
}

/** The App shows this as an approval card; DSH fails closed when nobody can answer. */
async function askOwner(config: RoutingConfig): Promise<PreDecision> {
  return {
    kind: 'ask',
    reason: message('routingApprovalReason', 'en', [config.model]),
    displayReason: {
      en: message('routingApprovalReason', 'en', [config.model]),
      'zh-CN': message('routingApprovalReason', 'zh-CN', [config.model]),
    },
  };
}
