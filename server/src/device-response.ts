/** JSON responses of the device API, localized at the owner boundary. */
import type { ServerResponse } from 'node:http';
import { localizedError, localizedReason } from './i18n.js';
import type { Language } from './preferences.js';

interface TaskView {
  state: string;
  tool: string;
  reason?: string;
  reasonText?: unknown;
  error?: unknown;
  result?: { text: string; untrusted?: boolean };
}
interface TransferView {
  state: string;
  source: unknown;
  destination: unknown;
  error: string;
  failure?: { code: string; message: string; hint: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function localizeTask(task: TaskView, lang: Language): TaskView {
  return {
    ...task,
    ...(task.reason ? { reason: localizedReason(task, lang) } : {}),
    ...(task.error ? { error: { ...(task.error as object), ...localizedError(task.error, lang) } } : {}),
  };
}

function localizeTransfer(transfer: TransferView, lang: Language): TransferView & { failure: unknown } {
  const failure = localizedError(transfer.failure ?? { message: transfer.error }, lang);
  return { ...transfer, error: failure.message, failure };
}

/** Localize tasks and transfers anywhere in a response value; everything else passes through. */
function localize(item: unknown, lang: Language): unknown {
  if (Array.isArray(item)) return item.map((entry) => localize(entry, lang));
  if (!isRecord(item) || !item.state) return item;
  if (item.tool) return localizeTask(item as unknown as TaskView, lang);
  if (item.source && item.destination && typeof item.error === 'string') {
    return localizeTransfer(item as unknown as TransferView, lang);
  }
  return item;
}

/** Turn `{ error: "English text" }` into the localized message, code and hint. */
function localizeFailure(value: unknown, lang: Language): unknown {
  if (!isRecord(value) || typeof value.error !== 'string') return value;
  const details = localizedError({ ...value, message: value.error }, lang);
  return { ...value, ...details, error: details.message };
}

export function sendJson(res: ServerResponse, status: number, value: unknown, lang: Language): void {
  const body = localize(status >= 400 ? localizeFailure(value, lang) : value, lang);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
