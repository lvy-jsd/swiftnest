import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  defaultLanguage,
  errorCode,
  language,
  localizedError,
  messageEn,
  messageZh,
  translateMessage,
} from '../src/language';
import { STRINGS, detectLang } from '../../cli/src/i18n';
import { lintUI, violations } from '../../../scripts/i18n-lint.mjs';
const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort();
it('requires zh keys and matching placeholders for all server/API messages and CLI strings', () => {
  expect(Object.keys(messageZh).sort()).toEqual(Object.keys(messageEn).sort());
  for (const key of Object.keys(messageEn) as (keyof typeof messageEn)[]) {
    expect(messageZh[key], key).not.toBe('');
    expect(placeholders(messageZh[key]), key).toEqual(placeholders(messageEn[key]));
  }
  for (const [key, pair] of Object.entries(STRINGS)) {
    expect(pair.zh, key).toBeTruthy();
    expect(pair.en, key).toBeTruthy();
  }
});
it('requires matching zh keys and format slots for the native catalog', () => {
  const read = (name: string) =>
    JSON.parse(
      readFileSync(new URL(`../../../native/locale/src/locales/${name}.json`, import.meta.url), 'utf8'),
    ) as Record<string, string>;
  const en = read('en'),
    zh = read('zh-CN');
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  for (const [key, value] of Object.entries(en))
    expect((zh[key]!.match(/\{[^{}]*\}/g) ?? []).sort(), key).toEqual((value.match(/\{[^{}]*\}/g) ?? []).sort());
});
it('defaults to Chinese regardless of OS language and accepts an explicit English override', () => {
  vi.stubEnv('SWIFTNEST_LANG', '');
  vi.stubEnv('LANG', 'en_US.UTF-8');
  vi.stubEnv('LC_ALL', 'en_US.UTF-8');
  try {
    expect(defaultLanguage()).toBe('zh-CN');
    expect(detectLang()).toBe('zh');
    expect(language('en')).toBe('en');
    expect(detectLang('en')).toBe('en');
    vi.stubEnv('SWIFTNEST_LANG', 'en');
    expect(defaultLanguage()).toBe('en');
    expect(detectLang()).toBe('en');
  } finally {
    vi.unstubAllEnvs();
  }
});
it('preserves codes and technical parameters while localizing message and hint', () => {
  const original = {
    code: 'DEVICE_OFFLINE',
    message: 'Device "laptop" is not connected.',
    suggestion: 'Wait for it to reconnect, then retry.',
  };
  expect(localizedError(original, 'zh-CN')).toEqual({
    code: 'DEVICE_OFFLINE',
    message: '设备“laptop”未连接。',
    hint: '请等待设备重连后重试。',
  });
  expect(localizedError(original, 'en').message).toBe(original.message);
  expect(errorCode('Unknown transfer')).toBe('UNKNOWN_TRANSFER');
  expect(translateMessage('来源文件已变化，请重新发起传输', 'en')).toBe('Source changed; start a new transfer');
  expect(translateMessage('Source changed; start a new transfer', 'zh-CN')).toBe('来源文件已变化，请重新发起传输');
  expect(translateMessage('my file.txt', 'zh-CN')).toBe('my file.txt');
  expect(translateMessage('Loading high-risk tool(s): delete_file', 'zh-CN')).toBe('正在加载高风险工具：delete_file');
});
it('rejects new prose in JSX, attributes, expressions and template strings while allowing technical tokens', () => {
  const allowed = new Set(['MCP']);
  for (const source of [
    'const C=()=> <p>Hello</p>',
    'const C=()=> <input placeholder="New label"/>',
    'const C=()=> <p>{"Failure happened"}</p>',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    'const C=()=> <p>{`New message ${1}`}</p>',
  ])
    expect(violations(source, allowed).length).toBeGreaterThan(0);
  expect(violations('const C=()=> <p>MCP</p>', allowed)).toEqual([]);
  expect(violations('// Hello comment\nconst C=()=> <p>{t("newKey")}</p>', allowed)).toEqual([]);
  expect(lintUI()).toEqual([]);
});

it('requires a Chinese counterpart for every English docs page', () => {
  function walk(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.md'))
        expect(existsSync(new URL(next.href.replace('/docs/en/', '/docs/zh/'))), next.pathname).toBe(true);
    }
  }
  walk(new URL('../../../docs/en/', import.meta.url));
});
