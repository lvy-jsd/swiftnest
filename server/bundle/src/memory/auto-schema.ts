import { z } from 'zod';
import { characters, memoryRules } from './rules.js';

const fact = z
  .string()
  .trim()
  .min(1)
  .refine((value) => characters(value) <= memoryRules.entry);
const topic = z.string().regex(memoryRules.topicName).optional();
export const memoryOperations = z
  .array(
    z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('add'), text: fact, topic }),
      z.strictObject({ op: z.literal('update'), id: z.string().min(1), text: fact, topic }),
      z.strictObject({ op: z.literal('none') }),
    ]),
  )
  .min(1)
  .max(20);
export type MemoryOperation = z.infer<typeof memoryOperations>[number];

export const autoStateSchema = z.strictObject({
  enabled: z.boolean().optional(),
  enabledAt: z.number().int().nonnegative().optional(),
  cursors: z.record(z.string(), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
});
