import { expect, it } from 'vitest';
import { apply, type RoutingConfig, type RoutingContext } from '../src/routing.js';

function context() {
  const sections: { name: string; text(): string }[] = [];
  const gates: ((exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>)[] = [];
  const ctx: RoutingContext = {
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
    on: (_event, listener) => {
      gates.push(listener as (typeof gates)[number]);
      return () => {};
    },
    effect: (effect) => {
      effect();
    },
  };
  return { ctx, sections, gates };
}

const config: RoutingConfig = { tool: 'ask_expert', model: 'deepseek-v4-pro', approval: 'ask' };
const allow = async () => ({ kind: 'allow' as const });

it('tells the main model when to hand off and to whom', () => {
  const test = context();
  apply(test.ctx, config);
  const guidance = test.sections[0]!.text();
  expect(guidance).toContain('ask_expert');
  expect(guidance).toContain('deepseek-v4-pro');
});

it('holds every hand-off for the owner in ask mode, in both languages, and leaves other tools alone', async () => {
  const test = context();
  apply(test.ctx, config);
  const decision = (await test.gates[0]!({ name: 'ask_expert' }, allow)) as {
    kind: string;
    displayReason: Record<string, string>;
  };
  expect(decision.kind).toBe('ask');
  expect(decision.displayReason.en).toContain('deepseek-v4-pro');
  expect(decision.displayReason['zh-CN']).toContain('专家模型');
  expect(await test.gates[0]!({ name: 'read_file' }, allow)).toEqual({ kind: 'allow' });
});

it('lets the assistant decide in auto mode', () => {
  const test = context();
  apply(test.ctx, { ...config, approval: 'auto' });
  expect(test.gates).toHaveLength(0);
  expect(test.sections).toHaveLength(1);
});
