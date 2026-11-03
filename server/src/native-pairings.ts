/** Private parent-only credential mutations. Public callers must first pass the bundle's DSH admission. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { text } from '@swiftnest/core';
import type { Device } from '@swiftnest/api';
import type { NativeGrant } from '@swiftnest/server-bundle/native-pairings-store';
import type { DeviceHub } from './device-routes.js';
import { readJsonObject } from './http.js';

export function nativeDevices(hub: DeviceHub): Device[] {
  return hub.nativePairings
    .list()
    .filter((r) => !r.device)
    .map((r) => ({
      device: r.id,
      name: r.name,
      kind: r.kind,
      paired: true,
      online: false,
      fingerprint: r.id.slice(4),
      pairedAt: new Date(r.createdAt).toISOString(),
      capabilities: [],
    }));
}

interface Result {
  status?: number;
  value?: unknown;
  changed?: boolean;
}
function issue(hub: DeviceHub, body: Record<string, unknown>): Result {
  const grant = body.grant as NativeGrant | undefined;
  if (
    grant?.principal?.kind !== 'owner' ||
    !['answer', 'none'].includes(grant.interactions) ||
    typeof body.audience !== 'string'
  )
    return { status: 403 };
  const issued = hub.nativePairings.issue(
    grant,
    body.audience,
    typeof body.name === 'string' ? body.name : undefined,
    body.kind === 'android' ? 'android' : 'desktop',
  );
  return { value: { credential: issued.credential }, changed: true };
}
function operate(hub: DeviceHub, action: string | undefined, body: Record<string, unknown>): Result {
  if (action === 'issue') return issue(hub, body);
  const { credential, audience } = body;
  if (typeof credential !== 'string' || typeof audience !== 'string') return { status: 401 };
  const record = hub.nativePairings.verify(credential, audience);
  if (!record) return { status: 401 };
  switch (action) {
    case 'resume':
      return { value: { ok: true } };
    case 'rotate':
      return { value: hub.nativePairings.rotate(credential, audience), changed: true };
    case 'revoke':
      return { value: { ok: hub.nativePairings.revoke(record.id) }, changed: true };
    case 'bind': {
      const device = hub.registry
        .list()
        .find((d) => d.paired && d.device === body.device && d.fingerprint === body.fingerprint);
      if (!device) return { status: 403 };
      const changed = record.device !== device.device || record.fingerprint !== device.fingerprint;
      return {
        value: { ok: !changed || hub.nativePairings.bind(credential, audience, device.device, device.fingerprint) },
        changed,
      };
    }
    default:
      return { status: 404 };
  }
}
export async function handleNativePairing(hub: DeviceHub, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const body = await readJsonObject(req, 4096, text('deviceArgumentsTooLarge'));
  const { status, value, changed } = operate(hub, req.url?.split('/').at(-1), body);
  if (changed) hub.publish('devices-changed');
  res
    .writeHead(status ?? 200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(value === undefined ? undefined : JSON.stringify(value));
}
