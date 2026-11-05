import { readdirSync, existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { defaultLanguage, language, localizedError, message, messageEn, messageZh } from '../src/language';
import { STRINGS, detectLang } from '../../cli/src/i18n';
import { catalogKeys, lintUI, violations } from '../../../scripts/i18n-lint.mjs';
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
it('shows prose without catalog text as is, or as a plain sentence naming its code for Chinese readers', () => {
  const thirdParty = { code: 'EACCES', message: 'permission denied, open /etc/shadow', hint: 'Run it as root.' };
  expect(localizedError(thirdParty, 'en')).toEqual(thirdParty);
  expect(localizedError(thirdParty, 'zh-CN')).toEqual({
    code: 'EACCES',
    message: message('genericError', 'zh-CN', ['EACCES']),
    hint: message('retryHint', 'zh-CN'),
  });
  expect(localizedError({ code: 'X', message: '磁盘已满' }, 'zh-CN').message).toBe('磁盘已满');
  expect(localizedError(new Error('boom'), 'en')).toMatchObject({ code: 'SWIFTNEST_FAILED', message: 'boom' });
});
it('recognizes namespaced catalog keys without allowing uncatalogued prose', () => {
  const keys = new Set(catalogKeys());
  expect(keys.has('home.plan')).toBe(true);
  expect(violations("const suggestion = { key: 'home.plan' };", keys)).toEqual([]);
  expect(violations("const suggestion = { key: 'Untranslated suggestion' };", keys)).toHaveLength(1);
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
