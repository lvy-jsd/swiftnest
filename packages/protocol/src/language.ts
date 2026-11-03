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
export type MessageKey = keyof typeof messageEn;
/** An argument of catalog text: a value shown as is, or more catalog text. */
export type TextArg = string | number | Text;
/**
 * Catalog text: a key and its arguments. Producers send this instead of finished prose, and
 * each reader renders it in their own language.
 */
export interface Text {
  key: MessageKey;
  args?: TextArg[];
}

export function text(key: MessageKey, ...args: TextArg[]): Text {
  return args.length ? { key, args } : { key };
}

/** True for catalog text whose key this build knows; text from a newer peer is not. */
export function isText(value: unknown): value is Text {
  const key = (value as { key?: unknown } | null)?.key;
  return typeof key === 'string' && Object.hasOwn(messageEn, key);
}

/** Render catalog text, and any text in its arguments, in `lang`. */
export function render(value: Text, lang: Language = defaultLanguage()): string {
  const args = (value.args ?? []).map((arg) => (typeof arg === 'object' ? render(arg, lang) : arg));
  return message(value.key, lang, args);
}

/**
 * Legacy: find the catalog entry a finished English or Chinese sentence came from. Only for
 * producers that still send prose; new code sends `Text`.
 */
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
/** Stable error codes for catalog messages that have a well-known one. */
const CODES: Partial<Record<keyof typeof messageEn, string>> = {
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
  auditLimitOutOfRange: 'BAD_LIMIT',
  deviceOffline: 'DEVICE_OFFLINE',
  approvalNoLongerPending: 'NOT_PENDING',
  deviceApiFailed: 'DEVICE_API_FAILED',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  invalidLanguage: 'INVALID_LANGUAGE',
  languageRequestTooLarge: 'REQUEST_TOO_LARGE',
  methodNotAllowed: 'METHOD_NOT_ALLOWED',
};

/** The error code for a failure whose message is this catalog entry. */
export function errorCodeFor(key: MessageKey): string {
  return CODES[key] ?? `SWIFTNEST_${key.toUpperCase()}`;
}

/** Legacy: the error code for a finished sentence, found by matching it to the catalog. */
export function errorCode(text: string): string {
  const item = patterns.find((item) => item.re.test(text));
  return item ? errorCodeFor(item.key) : 'SWIFTNEST_FAILED';
}
interface ErrorLike {
  code?: string;
  message?: string;
  hint?: string;
  suggestion?: string;
  text?: unknown;
  hintText?: unknown;
}

/** Localize a failure: catalog text when the producer sent it, else (legacy) the English sentence. */
export function localizedError(error: unknown, lang: Language = defaultLanguage()) {
  const source = error as ErrorLike | undefined;
  const original = source?.message ?? String(error);
  const code = source?.code ?? (isText(source?.text) ? errorCodeFor(source.text.key) : errorCode(original));
  return { code, message: localizedMessage(source, original, code, lang), hint: localizedHint(source, lang) };
}

function localizedMessage(source: ErrorLike | undefined, original: string, code: string, lang: Language): string {
  if (isText(source?.text)) return render(source.text, lang);
  const translated = translateMessage(original, lang);
  // Third-party failures have an unbounded vocabulary. Keep their stable code and offer a localized action.
  if (lang === 'zh-CN' && translated === original && /^\p{ASCII}*[a-z]{2} [a-z]/iu.test(original))
    return message('genericError', lang, [code]);
  return translated;
}

function localizedHint(source: ErrorLike | undefined, lang: Language): string {
  if (isText(source?.hintText)) return render(source.hintText, lang);
  const raw = source?.hint ?? source?.suggestion ?? messageEn.retryHint;
  const hint = translateMessage(raw, lang);
  if (lang === 'zh-CN' && hint === raw && !/[\u4e00-\u9fff]/.test(hint)) return message('retryHint', lang);
  return hint;
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
