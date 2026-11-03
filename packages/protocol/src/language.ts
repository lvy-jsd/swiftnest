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

interface ErrorLike {
  code?: string;
  message?: string;
  hint?: string;
  suggestion?: string;
  text?: unknown;
  hintText?: unknown;
}

/**
 * Localize a failure from its catalog text. A failure without one comes from a peer we don't
 * control (an OS error, a third-party plugin): its prose is shown as is, except that a Chinese
 * reader gets a plain sentence naming the code instead of unexplained English.
 */
export function localizedError(error: unknown, lang: Language = defaultLanguage()) {
  const source = error as ErrorLike | undefined;
  const code = source?.code ?? (isText(source?.text) ? errorCodeFor(source.text.key) : 'SWIFTNEST_FAILED');
  return { code, message: localizedMessage(source, error, code, lang), hint: localizedHint(source, lang) };
}

function localizedMessage(source: ErrorLike | undefined, error: unknown, code: string, lang: Language): string {
  if (isText(source?.text)) return render(source.text, lang);
  const prose = source?.message ?? String(error);
  return lang === 'zh-CN' && isEnglishProse(prose) ? message('genericError', lang, [code]) : prose;
}

function localizedHint(source: ErrorLike | undefined, lang: Language): string {
  if (isText(source?.hintText)) return render(source.hintText, lang);
  const prose = source?.hint ?? source?.suggestion;
  return prose && !(lang === 'zh-CN' && isEnglishProse(prose)) ? prose : message('retryHint', lang);
}

/** An English sentence, as opposed to Chinese text or a bare technical value. */
const isEnglishProse = (text: string) => /^\p{ASCII}*[a-z]{2} [a-z]/iu.test(text);

/** Why the policy decided as it did, from its catalog text; a reason without one is shown as is. */
export function localizedReason(item: { reason?: string; reasonText?: unknown }, lang: Language = defaultLanguage()) {
  return isText(item.reasonText) ? render(item.reasonText, lang) : (item.reason ?? '');
}
