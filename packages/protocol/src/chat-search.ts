/** Private, rebuildable search over the owner's conversations. */
import { z } from 'zod';

export const ChatSearchSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    semantic: z.boolean().default(true),
    embeddings: z
      .object({
        source: z.enum(['local', 'cloud']).default('local'),
        model: z
          .string()
          .regex(/^[\w.:/@-]{1,128}$/)
          .optional(),
        cloudConsent: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type ChatSearchSettings = z.infer<typeof ChatSearchSettingsSchema>;
export interface ChatSearchResult {
  id: number;
  sessionId: string;
  title: string;
  time: number;
  role: 'user' | 'assistant';
  snippet: string;
  /** UTF-16 offsets into snippet, rendered as text and <mark>, never HTML. */
  highlights: [number, number][];
}
export interface ChatSearchStatus {
  indexedMessages: number;
  semantic: boolean;
  embeddingSource: 'local' | 'cloud' | null;
  embeddingModel: string | null;
  indexing: boolean;
  indexingFailed: boolean;
  settings: ChatSearchSettings;
}
