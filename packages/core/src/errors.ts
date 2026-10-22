import type { SwiftnestError } from "@swiftnest/protocol";

/** An error that carries a fix: every failure a user can hit should say what to do next. */
export class SwiftnestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly suggestion?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SwiftnestFailure";
  }

  toJSON(): SwiftnestError {
    return { code: this.code, message: this.message, suggestion: this.suggestion, retryable: this.retryable };
  }

  static from(e: unknown, fallbackCode = "INTERNAL"): SwiftnestError {
    if (e instanceof SwiftnestFailure) return e.toJSON();
    const err = e as { code?: unknown; message?: unknown };
    return {
      code: typeof err?.code === "string" ? err.code : fallbackCode,
      message: typeof err?.message === "string" ? err.message : String(e),
      retryable: false,
    };
  }
}
