import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { apply } from '../src/memory.js';

function context() {
  const tools = new Map<string, any>();
  const sections: any[] = [];
  const routes: any[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const disposals: (() => void)[] = [];
  const ctx: Parameters<typeof apply>[0] = {
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    llm: { stream: async function* () {} },
    sessions: { list: () => [], flush: async () => {} },
    sessionPersistence: {
      list: async () => [],
      open: async () => {
        throw new Error('unused');
      },
    },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
    effect: (effect) => {
      disposals.push(effect());
    },
  };
  return { ctx, tools, sections, routes, disposals, listeners };
}

it('registers generic memory tools, reports catalog failures and freezes a literal prompt block', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-memory-plugin-'));
  const test = context();
  try {
    apply(test.ctx, { home });
    const exec = { agent: { id: 'session-one' } };
    const remember = test.tools.get('remember');
    expect(await remember.execute({ text: 'Literal {{unknown}}' }, exec)).toEqual({ text: 'Saved.' });
    expect(await remember.execute({ text: 'Literal {{unknown}}' }, exec)).toEqual({ text: 'Already saved.' });
    await expect(remember.execute({ text: 'password=hidden' }, exec)).rejects.toMatchObject({
      text: { key: 'memorySecret' },
    });
    const section = test.sections[0];
    expect(section.interpolate).toBe(false);
    expect(section.text({})).toBe('');
    const frozen = section.text(exec);
    expect(frozen).toContain('Literal {{unknown}}');
    expect(frozen).toContain('recall');
    const recalled = await test.tools.get('recall').execute({}, exec);
    expect(JSON.parse(recalled.text).entries[0].source).toBe('session:session-one');
    await test.tools.get('forget').execute({ text: 'Literal {{unknown}}' }, exec);
    await expect(test.tools.get('forget').execute({ id: 'missing' }, exec)).rejects.toMatchObject({
      text: { key: 'memoryNotFound' },
    });
    expect(section.text(exec)).toBe(
      frozen
        .split('\n')
        .filter((line: string) => !line.includes('Literal {{unknown}}'))
        .join('\n'),
    );
    test.listeners.get('session/disposed')!({ id: 'session-one' });
    expect(existsSync(join(home, 'memory', 'snapshots', 'session-one.md'))).toBe(false);
    expect(section.text({ agent: { id: 'session-two' } })).not.toContain('Literal {{unknown}}');
  } finally {
    for (const dispose of test.disposals) dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

it('disabling memory registers only its owner API and leaves storage untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-memory-disabled-'));
  try {
    const test = context();
    apply(test.ctx, { home, enabled: false });
    expect(test.tools.size).toBe(0);
    expect(test.sections).toHaveLength(0);
    expect(test.routes).toHaveLength(1);
    expect(existsSync(join(home, 'memory'))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
