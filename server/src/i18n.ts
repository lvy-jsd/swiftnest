import { errorCode } from '@swiftnest/core';
export { message, localizedError, translateMessage, translateReason } from '@swiftnest/core';
/** Keep the original message for logs and localize when crossing the owner boundary. */
export class ServerFailure extends Error {
  readonly code: string;
  constructor(message: string, code = errorCode(message), readonly hint?: string) { super(message); this.code = code; }
}
