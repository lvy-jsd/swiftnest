import { text, ChatSearchSettingsSchema } from '@swiftnest/protocol';
import { ServerFailure } from '../memory/failure.js';

export function searchSettings(value: unknown = {}) {
  const result = ChatSearchSettingsSchema.safeParse(value);
  if (!result.success) throw new ServerFailure(text('chatSearchInvalidSettings'));
  return result.data;
}
