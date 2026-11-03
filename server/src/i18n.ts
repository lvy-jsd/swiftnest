import { errorCodeFor, SwiftnestFailure, type Text } from '@swiftnest/core';
export { message, localizedError, translateMessage, translateReason } from '@swiftnest/core';

/** A server failure: catalog text, with the code that belongs to it unless one is given. */
export class ServerFailure extends SwiftnestFailure {
  constructor(message: Text, code = errorCodeFor(message.key)) {
    super(code, message);
  }
}
