import { errorCodeFor, SwiftnestFailure, type Text } from '@swiftnest/core';

export class ServerFailure extends SwiftnestFailure {
  constructor(value: Text) {
    super(errorCodeFor(value.key), value);
  }
}
