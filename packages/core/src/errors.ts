import { isText, render, type SwiftnestError, type Text } from '@swiftnest/protocol';

/** What a failure says: catalog text, or English prose that has no catalog entry. */
type Words = string | Text;

const english = (words: Words) => (typeof words === 'string' ? words : render(words, 'en'));

/** An error that carries a fix: every failure a user can hit should say what to do next. */
export class SwiftnestFailure extends Error {
  /** The catalog text behind `message`, so each reader can localize it. */
  readonly text?: Text;
  readonly hintText?: Text;
  readonly suggestion?: string;

  constructor(
    readonly code: string,
    message: Words,
    suggestion?: Words,
    readonly retryable = false,
  ) {
    super(english(message));
    this.name = 'SwiftnestFailure';
    if (typeof message !== 'string') this.text = message;
    if (suggestion !== undefined) this.suggestion = english(suggestion);
    if (suggestion !== undefined && typeof suggestion !== 'string') this.hintText = suggestion;
  }

  /** English prose plus the catalog text, so each reader can show it in their language. */
  toJSON(): SwiftnestError {
    return {
      code: this.code,
      message: this.message,
      ...(this.text ? { text: this.text } : {}),
      ...(this.suggestion ? { hint: this.suggestion, suggestion: this.suggestion } : {}),
      ...(this.hintText ? { hintText: this.hintText } : {}),
      retryable: this.retryable,
    };
  }

  /** Rebuild a failure received on the wire, keeping its catalog text. */
  static fromWire(e: SwiftnestError): SwiftnestFailure {
    const message = isText(e.text) ? e.text : e.message;
    const hint = isText(e.hintText) ? e.hintText : (e.hint ?? e.suggestion);
    return new SwiftnestFailure(e.code, message, hint, e.retryable);
  }

  static from(e: unknown, fallbackCode = 'INTERNAL'): SwiftnestError {
    if (e instanceof SwiftnestFailure) return e.toJSON();
    const err = e as { code?: unknown; message?: unknown };
    return {
      code: typeof err?.code === 'string' ? err.code : fallbackCode,
      message: typeof err?.message === 'string' ? err.message : String(e),
      retryable: false,
    };
  }
}
