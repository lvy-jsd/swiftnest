import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { expect, it } from 'vitest';
import { SwiftnestError } from '../src/index';
import { isText, localizedError, messageEn, render, text } from '../src/language';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const slots = (key: keyof typeof messageEn) => new Set(messageEn[key].match(/\{\d+\}/g) ?? []).size;

it('renders catalog text, including text in its arguments, in the reader language', () => {
  const closed = text('connectionClosedDuringStepBecause', text('handshakeStep'), 'reset');
  expect(render(closed, 'en')).toBe('Connection closed during the handshake: reset.');
  expect(render(closed, 'zh-CN')).toBe('握手 期间连接已关闭：reset。');
  expect(render(text('timedOutAfterMs', 500), 'en')).toBe('Timed out after 500 ms.');
});

it.each([
  ['memoryEntryLimit', 300, 'Memory entries must be at most 300 characters.', '每条记忆最多 300 个字符。'],
  [
    'memoryIndexLimit',
    4000,
    'MEMORY.md must be at most 4000 characters. Use a topic for details.',
    'MEMORY.md 最多 4000 个字符，请将详细内容放入主题。',
  ],
  ['memoryTopicLimit', 16000, 'A memory topic must be at most 16000 characters.', '每个记忆主题最多 16000 个字符。'],
  ['memoryTopicsLimit', 40, 'Memory supports at most 40 topics.', '最多保存 40 个记忆主题。'],
  ['memoryApiReturnedHttp', 503, 'Memory API returned HTTP 503', '记忆 API 返回 HTTP 503'],
  [
    'memoryAutoSkippedLog',
    2,
    'Automatic memory review skipped 2 invalid operations.',
    '自动记忆审阅已跳过 2 条无效操作。',
  ],
] as const)('renders migrated memory message %s in both reader languages', (key, value, en, zh) => {
  const content = text(key, value);
  expect(render(content, 'en')).toBe(en);
  expect(render(content, 'zh-CN')).toBe(zh);
});

it('localizes a failure from its catalog text, falling back to its English for unknown keys', () => {
  const failure = {
    code: 'DEVICE_OFFLINE',
    message: 'Device "laptop" is not connected.',
    text: text('deviceNotConnected', 'laptop'),
    hintText: text('hintWaitForReconnect'),
  };
  expect(localizedError(failure, 'zh-CN')).toEqual({
    code: 'DEVICE_OFFLINE',
    message: '设备“laptop”未连接。',
    hint: '请等待设备重连后重试。',
  });
  const fromNewerPeer = SwiftnestError.parse({ code: 'X', message: 'Plain English.', text: { key: 'notInThisBuild' } });
  expect(isText(fromNewerPeer.text)).toBe(false);
  expect(localizedError(fromNewerPeer, 'en').message).toBe('Plain English.');
});

/** Every `text('key', ...)` in the sources passes exactly as many arguments as the entry has slots. */
it('passes each catalog key the arguments its sentence expects', () => {
  const sources = ['packages', 'server', 'plugins', 'client/src'].flatMap((dir) => sourceFiles(join(root, dir)));
  const wrong: string[] = [];
  for (const file of sources) {
    for (const call of textCalls(readFileSync(file, 'utf8'))) {
      if (!Object.hasOwn(messageEn, call.key)) continue; // TypeScript rejects unknown keys.
      const expected = slots(call.key as keyof typeof messageEn);
      if (call.args !== expected) wrong.push(`${file.slice(root.length)}:${call.line} ${call.key}`);
    }
  }
  expect(wrong).toEqual([]);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'test', 'gen'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function textCalls(source: string): { key: string; args: number; line: number }[] {
  const calls: { key: string; args: number; line: number }[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; callee?: { name?: string }; arguments?: { type: string; value?: string }[] };
    const [first, ...rest] = n.arguments ?? [];
    if (n.type === 'CallExpression' && n.callee?.name === 'text' && first?.type === 'StringLiteral') {
      calls.push({
        key: first.value!,
        args: rest.length,
        line: (node as { loc: { start: { line: number } } }).loc.start.line,
      });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) for (const child of value) visit(child);
      else visit(value);
    }
  };
  visit(parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }));
  return calls;
}
