import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function uiFiles(dir = resolve(root, 'client/src')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? uiFiles(resolve(dir, entry.name))
      : entry.name.endsWith('.tsx') && entry.name !== 'i18n.tsx'
        ? [resolve(dir, entry.name)]
        : [],
  );
}
/** Scan actual language tokens, ignoring comments. JSX prose is checked separately. */
export function rawLiterals(source) {
  const result = [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXText' && /[A-Za-z]/.test(node.value))
      result.push({ value: node.value.trim(), line: node.loc.start.line });
    if (node.type === 'StringLiteral' || node.type === 'TemplateElement') {
      const value = node.type === 'StringLiteral' ? node.value : node.value.cooked;
      const skipped =
        parent?.type === 'ImportDeclaration' ||
        parent?.type === 'ExportNamedDeclaration' ||
        parent?.type === 'TSLiteralType' ||
        (parent?.type === 'CallExpression' &&
          ((parent.callee.type === 'Identifier' && parent.callee.name === 't') || parent.callee.type === 'Import'));
      if (!skipped && /[A-Za-z]/.test(value)) result.push({ value, line: node.loc.start.line });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) for (const child of value) visit(child, node);
      else if (value && typeof value === 'object') visit(value, node);
    }
  }
  visit(ast);

  return result;
}
export function violations(source, allowlist) {
  return rawLiterals(source).filter(({ value }) => !allowlist.has(value));
}
/** Catalog keys (e.g. 'pairThisPhone') are identifiers, not prose, wherever they appear in code. */
export function catalogKeys() {
  const catalog = readFileSync(resolve(root, 'client/src/i18n.tsx'), 'utf8');
  const keys = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectProperty' && node.key.type === 'Identifier' && node.value.type === 'StringLiteral')
      keys.push(node.key.name);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) for (const child of value) visit(child);
      else visit(value);
    }
  })(parse(catalog, { sourceType: 'module', plugins: ['typescript', 'jsx'] }));
  return [
    ...keys,
    ...Object.keys(JSON.parse(readFileSync(resolve(root, 'packages/protocol/src/locales/en.json'), 'utf8'))),
  ];
}
export function lintUI() {
  const tokens = JSON.parse(readFileSync(resolve(root, 'scripts/i18n-technical-tokens.json'), 'utf8')).tokens;
  const allowlist = new Set([...tokens, ...catalogKeys()]);
  return uiFiles().flatMap((file) =>
    violations(readFileSync(file, 'utf8'), allowlist).map(
      ({ line, value }) => `${file.slice(root.length)}:${line}: ${JSON.stringify(value)}`,
    ),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = lintUI();
  if (found.length) {
    console.error(`UI 文案必须使用 i18n key；技术标记须显式列入允许列表。\n${found.join('\n')}`);
    process.exitCode = 1;
  } else console.log('i18n：UI 字符串检查通过。');
}
