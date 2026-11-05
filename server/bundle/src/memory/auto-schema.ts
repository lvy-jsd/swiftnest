import { z } from 'zod';

// Validate the JSON structure here; the store checks each fact against its write rules.
const topic = z.string().optional();
export const memoryOperations = z
  .array(
    z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('add'), text: z.string(), topic }),
      z.strictObject({ op: z.literal('update'), id: z.string(), text: z.string(), topic }),
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
