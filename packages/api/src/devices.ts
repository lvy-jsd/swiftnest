/** Device hub contracts; no DSH types or device execution code in the App. */
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
export interface DevicePairingCandidate { id: string; device: string; fingerprint: string }
export type DeviceEvent = { type: 'devices-changed' | 'approval-pending' | 'approvals-changed' | 'pairing-changed' };
export interface DeviceSubscription extends AsyncIterableIterator<DeviceEvent> { close(): void }
