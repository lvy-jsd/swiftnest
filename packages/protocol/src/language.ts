import { messageEn, messageZh } from './messages.js';
export { messageEn, messageZh } from './messages.js';
export type Language = 'zh-CN' | 'en';
export function language(value?: string): Language {
  return value === 'en' ? 'en' : 'zh-CN';
}
export function defaultLanguage(): Language {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('swiftnest.locale');
      if (saved === 'en' || saved === 'zh-CN') return saved;
    }
  } catch {
    /* Storage unavailable. */
  }
  return language(
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SWIFTNEST_LANG,
  );
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const makePatterns = (table: Record<string, string>) =>
  Object.entries(table)
    .filter(([key]) => key !== 'riskReason')
    .map(([key, value]) => {
      const parts = value.split(/(\{\d+\})/);
      const slots = parts.filter((p) => /^\{\d+\}$/.test(p));
      return {
        key: key as keyof typeof messageEn,
        value,
        slots,
        re: new RegExp(`^${parts.map((p) => (/^\{\d+\}$/.test(p) ? '([\\s\\S]*?)' : escapeRegExp(p))).join('')}$`),
      };
    })
    .sort((a, b) => a.slots.length - b.slots.length || b.value.length - a.value.length);
const patterns = makePatterns(messageEn);
const chinesePatterns = makePatterns(messageZh);
export function message(
  key: keyof typeof messageEn,
  lang: Language = defaultLanguage(),
  args: readonly unknown[] = [],
): string {
  return (lang === 'en' ? messageEn : messageZh)[key].replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)] ?? ''));
}
/** Match only full catalog messages. User content and technical output are never translated. */
export function translateMessage(text: string, lang: Language = defaultLanguage()): string {
  const source = lang === 'en' ? chinesePatterns : patterns;
  for (const item of source) {
    const match = item.re.exec(text);
    if (!match) continue;
    const args: string[] = [];
    item.slots.forEach((slot, i) => {
      args[Number(slot.slice(1, -1))] = match[i + 1]!;
    });
    return message(item.key, lang, args);
  }
  return text;
}
export function errorCode(text: string): string {
  const item = patterns.find((item) => item.re.test(text));
  const codes: Partial<Record<keyof typeof messageEn, string>> = {
    unknownPairedDevice: 'UNKNOWN_DEVICE',
    transfersStopped: 'TRANSFERS_STOPPED',
    unknownTransfer: 'UNKNOWN_TRANSFER',
    sourceChangedStartNewTransfer: 'SOURCE_CHANGED',
    linkDropped: 'DISCONNECTED',
    transferStalled: 'TRANSFER_STALLED',
    deviceArgumentsTooLarge: 'ARGS_TOO_LARGE',
    unknownDeviceTool: 'UNKNOWN_TOOL',
    expectedObjectArguments: 'BAD_ARGS',
    deviceOfflineLastSeen: 'DEVICE_OFFLINE',
    transferRequestTooLarge: 'REQUEST_TOO_LARGE',
    unknownTransferRoute: 'NOT_FOUND',
    notFound: 'NOT_FOUND',
    limitMust11000: 'BAD_LIMIT',
    deviceOffline: 'DEVICE_OFFLINE',
    approvalNoLongerPending: 'NOT_PENDING',
    deviceApiFailed: 'DEVICE_API_FAILED',
    unauthorized: 'UNAUTHORIZED',
    forbidden: 'FORBIDDEN',
    invalidLanguage: 'INVALID_LANGUAGE',
    languageSize: 'REQUEST_TOO_LARGE',
    method: 'METHOD_NOT_ALLOWED',
  };
  return item ? (codes[item.key] ?? `SWIFTNEST_${item.key.toUpperCase()}`) : 'SWIFTNEST_FAILED';
}
export function localizedError(error: unknown, lang: Language = defaultLanguage()) {
  const source = error as { code?: string; message?: string; hint?: string; suggestion?: string };
  const original = source?.message ?? String(error),
    code = source?.code ?? errorCode(original);
  let translated = translateMessage(original, lang);
  // Third-party failures have an unbounded vocabulary. Keep their stable code and offer a localized action.
  if (lang === 'zh-CN' && translated === original && /^\p{ASCII}*[a-z]{2} [a-z]/iu.test(original))
    translated = message('genericError', lang, [code]);
  const rawHint = source?.hint ?? source?.suggestion ?? messageEn.retryHint;
  let hint = translateMessage(rawHint, lang);
  if (lang === 'zh-CN' && hint === rawHint && !/[\u4e00-\u9fff]/.test(hint)) hint = message('retryHint', lang);
  return { code, message: translated, hint };
}

/** Localize policy explanations without changing client names, paths, arguments or rule identifiers. */
export function translateReason(text: string, lang: Language = defaultLanguage()): string {
  const approval = /^(.*?)(?:; approved by |；批准人：)(.*)$/s.exec(text);
  if (approval) return message('approvedBy', lang, [translateReason(approval[1]!, lang), approval[2]]);
  const policy =
    /^(?:default for |默认权限规则：)(read|write|exec|sensitive|读取|写入|执行|敏感操作)(?:[ (（]+(.*?)[)）])?$/s.exec(
      text,
    );
  if (policy) {
    const risk = translateMessage(policy[1]!, lang);
    return message('policyDefault', lang, [
      policy[2] ? message('riskReason', lang, [risk, translateMessage(policy[2], lang)]) : risk,
    ]);
  }
  return translateMessage(text, lang);
}
