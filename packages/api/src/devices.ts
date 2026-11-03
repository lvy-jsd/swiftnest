/** Device hub contracts; no DSH types or device execution code in the App. */
import type { SwiftnestError } from '@swiftnest/protocol';
export type { TaskSnapshot as DeviceApproval, AuditEntry as DeviceAuditEntry } from '@swiftnest/protocol';
export interface Device {
  device: string;
  slug?: string;
  name?: string;
  kind?: 'desktop' | 'android';
  online: boolean;
  paired: boolean;
  fingerprint: string;
  via?: string;
  lastSeen?: string;
  pairedAt?: string;
  capabilities: { id: string; version: string; tools: string[] }[];
}
export interface DevicePairing {
  code: string;
  expiresAt: string;
  address: string;
  port: number;
  url: string;
  fingerprint: string;
}
export interface DevicePairingCandidate {
  id: string;
  device: string;
  fingerprint: string;
}
export type DeviceEvent = {
  type:
    | 'devices-changed'
    | 'approval-pending'
    | 'approvals-changed'
    | 'pairing-changed'
    | 'transfers-changed'
    | 'plugins-changed'
    | 'models-changed'
    | 'memory-changed';
};
export interface DeviceSubscription extends AsyncIterableIterator<DeviceEvent> {
  close(): void;
}

export interface TransferRequest {
  /** Paired slug, or "server" (paths relative to config.home/files). */
  source: { device: string; path: string };
  destination: { device: string; path: string };
  routing?: 'auto' | 'relay';
}
export interface Transfer extends TransferRequest {
  id: string;
  name: string;
  size: number;
  offset: number;
  state: 'preparing' | 'approval' | 'waiting' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled';
  route: 'relay' | 'direct';
  speed: number;
  eta: number | null;
  updatedAt: number;
  approvalId?: string;
  error?: string;
  /** Localized for the owner; `text` and `hintText` let a reader localize it again. */
  failure?: { code: string; message: string; hint: string } & Pick<SwiftnestError, 'text' | 'hintText'>;
  hash?: string;
}
