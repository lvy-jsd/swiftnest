import { z } from 'zod';

export const ApprovalKind = z.enum(['dsh', 'device', 'transfer']);
export type ApprovalKind = z.infer<typeof ApprovalKind>;
const timeout = z.number().int().min(1000).max(86_400_000).default(600_000);
export const ApprovalSettingsSchema = z
  .object({
    remind: z.boolean().default(true),
    autoAllowLowRisk: z.boolean().default(false),
    timeouts: z.object({ dsh: timeout, device: timeout, transfer: timeout }).strict().prefault({}),
  })
  .strict();
export type ApprovalSettings = z.infer<typeof ApprovalSettingsSchema>;
export interface ApprovalActor {
  who: string;
  device: string;
}
export interface ApprovalItem {
  id: string;
  kind: ApprovalKind;
  requester: string;
  summary: string;
  risk: 'read' | 'write' | 'exec' | 'sensitive';
  createdAt: string;
  expiresAt: string;
  state: 'pending' | 'allowed' | 'denied' | 'expired';
  args: Record<string, unknown>;
  sessionId?: string;
  tool: string;
  device: string;
  displayReason?: { en: string; [locale: string]: string };
}
export interface ApprovalInboxView {
  items: ApprovalItem[];
  settings: ApprovalSettings;
}

export const DshApprovalRequestSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().min(1).max(256),
    requester: z.string().max(512),
    summary: z.string().max(8192),
    tool: z.string().max(256),
    args: z.record(z.string(), z.unknown()),
    displayReason: z.object({ en: z.string() }).catchall(z.string()).optional(),
  })
  .strict();
