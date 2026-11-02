/** The Nest and its two loopback surfaces belong to the parent, never the DSH child. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { Nest, JsonDeviceStore, JsonlAuditLog, loadOrCreateIdentity, RulePolicy, fingerprintOf } from '@swiftnest/core';
import { serveLan } from '@swiftnest/link-lan';
import { serveMcpHttp } from '@swiftnest/surface-mcp';
import type { Device, DeviceEvent } from '@swiftnest/api';
import type { ServerConfig } from './config.js';

export const MCP_TOKEN_ENV = 'SWIFTNEST_DEVICES_MCP_TOKEN';
export const ADMIN_TOKEN_ENV = 'SWIFTNEST_DEVICES_ADMIN_TOKEN';
export const ADMIN_URL_ENV = 'SWIFTNEST_DEVICES_ADMIN_URL';
const PREFIX = '/swiftnest/api/devices';
const secret = () => randomBytes(32).toString('base64url');
const json = (res: ServerResponse, status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));

export async function startDevices(config: ServerConfig) {
  const dir = join(config.home, 'devices');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const nest = new Nest({
    identity: await loadOrCreateIdentity(join(dir, 'identity.pem')),
    devices: await JsonDeviceStore.open(join(dir, 'paired.json')),
    audit: new JsonlAuditLog(join(dir, 'audit.jsonl')),
    policy: new RulePolicy(),
  });
  let cached: Record<string, Device> = {};
  const metadata = join(dir, 'seen.json');
  try { cached = JSON.parse(await readFile(metadata, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  const streams = new Set<ServerResponse>();
  const publish = (type: DeviceEvent['type']) => {
    for (const res of streams) {
      if (!res.write(`data: ${JSON.stringify({ type })}\n\n`)) res.destroy();
    }
  };
  const list = (): Device[] => {
    const online = new Map(nest.devices().map(d => [d.device, d]));
    const paired = new Map(nest.devicesStore.list().map(d => [d.device, d]));
    return [...new Set([...paired.keys(), ...online.keys()])].map(device => {
      const live = online.get(device), stored = paired.get(device);
      return { ...cached[device], ...live, device, online: !!live, paired: !!stored,
        fingerprint: live?.fingerprint ?? fingerprintOf(stored!.publicKey), pairedAt: stored?.pairedAt,
        capabilities: live?.capabilities ?? cached[device]?.capabilities ?? [] };
    });
  };
  const offTools = nest.onToolsChanged(() => {
    const now = new Date().toISOString();
    const live = new Map(nest.devices().map(d => [d.device, d]));
    const next: Record<string, Device> = Object.create(null);
    for (const d of list()) next[d.device] = { ...d, lastSeen: live.has(d.device) || cached[d.device]?.online ? now : d.lastSeen };
    cached = next;
    const data = JSON.stringify(cached);
    writes = writes.then(async () => {
      await writeFile(`${metadata}.tmp`, data, { mode: 0o600 });
      await rename(`${metadata}.tmp`, metadata);
    }).catch(error => nest.logger.error('device metadata write failed', error));
    publish('devices-changed');
  });
  const offTasks = nest.tasks.onChange(s => publish(s.state === 'pending_approval' ? 'approval-pending' : 'approvals-changed'));
  const offPairing = nest.pairing.onChange(() => publish('pairing-changed'));
  const mcpToken = secret(), adminToken = secret();
  let lan: Awaited<ReturnType<typeof serveLan>> | undefined;
  let mcp: Awaited<ReturnType<typeof serveMcpHttp>> | undefined;
  const admin = createServer((req, res) => {
    void (async () => {
      const expected = Buffer.from(`Bearer ${adminToken}`), given = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return void json(res, 401, { error: 'Unauthorized' });
      // The authenticated bundle proxy is the only caller. Never trust a forwarded target or identity.
      if (req.headers.origin) return void json(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.slice(PREFIX.length);
      if (!url.pathname.startsWith(PREFIX + '/') && url.pathname !== PREFIX) return void json(res, 404, { error: 'Not found' });
      if (req.method === 'GET') {
        if (path === '' || path === '/') return void json(res, 200, list());
        if (path === '/approvals') return void json(res, 200, nest.tasks.list({ state: 'pending_approval' }));
        if (path === '/pairing') return void json(res, 200, nest.pairing.pending().map(({ id, device, fingerprint }) => ({ id, device, fingerprint })));
        if (path === '/audit') {
          const limit = Number(url.searchParams.get('limit') ?? 100);
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return void json(res, 400, { error: 'limit must be 1-1000' });
          return void json(res, 200, await nest.audit.query({ limit }));
        }
        if (path === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
          streams.add(res);
          res.write('data: {"type":"devices-changed"}\n\n');
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
          res.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
          return;
        }
      }
      if (req.method === 'POST') {
        // No user-supplied arguments are needed: decisions are explicit URL actions.
        if (path === '/pairing') {
          const bound = config.devices.host;
          const address = bound === '0.0.0.0' || bound === '::'
            ? Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address ?? config.host : bound;
          const host = address.includes(':') ? `[${address}]` : address;
          return void json(res, 200, { ...nest.pairing.start(), address, port: lan!.port, url: `ws://${host}:${lan!.port}/swiftnest`, fingerprint: nest.identity.fingerprint });
        }
        const match = /^\/(approvals|pairing|revoke)\/([^/]+)(?:\/(approve|deny))?$/.exec(path);
        if (match) {
          const [, kind, raw, action] = match;
          const id = decodeURIComponent(raw!);
          if (kind === 'revoke' && !action) return void json(res, await nest.revoke(id) ? 200 : 404, { device: id });
          if (kind === 'pairing' && action) return void json(res, nest.pairing.confirm(id, action === 'approve') ? 200 : 409, { id });
          if (kind === 'approvals' && action) {
            if (nest.tasks.get(id)?.state !== 'pending_approval') return void json(res, 409, { error: 'Approval is no longer pending' });
            return void json(res, 200, action === 'approve' ? await nest.tasks.approve(id, 'App owner') : await nest.tasks.deny(id, 'denied in App'));
          }
        }
      }
      json(res, 404, { error: 'Not found' });
    })().catch(error => { nest.logger.error('device API failed', error); if (!res.headersSent) json(res, 500, { error: 'Device API failed' }); else res.destroy(); });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    offTasks(); offPairing();
    nest.pairing.stop();
    for (const p of nest.pairing.pending()) nest.pairing.confirm(p.id, false);
    for (const t of nest.tasks.list()) if (['pending_approval', 'queued', 'running'].includes(t.state)) await nest.tasks.cancel(t.id);
    for (const res of streams) res.end();
    const done = new Promise<void>(resolve => admin.close(() => resolve()));
    admin.closeAllConnections();
    await done;
    await mcp?.close();
    await lan?.close();
    await nest.close();
    offTools();
    await writes;
  })();
  try {
    lan = await serveLan(nest, { host: config.devices.host, port: config.devices.port, advertise: config.devices.mdns });
    mcp = await serveMcpHttp(nest, { host: '127.0.0.1', port: 0, bearerToken: mcpToken });
    await new Promise<void>((resolve, reject) => { admin.once('error', reject); admin.listen(0, '127.0.0.1', resolve); });
    const port = (admin.address() as { port: number }).port;
    return { nest, mcpUrl: mcp.url, lanUrl: lan.url,
      env: { [MCP_TOKEN_ENV]: mcpToken, [ADMIN_TOKEN_ENV]: adminToken, [ADMIN_URL_ENV]: `http://127.0.0.1:${port}` }, close };
  } catch (error) { await close(); throw error; }
}
