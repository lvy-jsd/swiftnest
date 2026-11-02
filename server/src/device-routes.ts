/**
 * Routes of the loopback device API. Two callers reach it, both with the admin bearer token:
 * the owner-facing bundle (PREFIX) and DSH's private control surface (CONTROL), which the
 * owner proxy never mounts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Nest } from '@swiftnest/core';
import type { TransferRequest } from '@swiftnest/api';
import type { ServerConfig } from './config.js';
import type { DeviceRegistry } from './device-registry.js';
import { sendJson } from './device-response.js';
import { HttpError, openEventStream, readBody, readJsonObject } from './http.js';
import { isLanguage, type Preferences } from './preferences.js';
import type { Transfers } from './transfers.js';

export const PREFIX = '/swiftnest/api/devices';
export const CONTROL = '/swiftnest/control/devices';
const KiB = 1024;

export interface DeviceHub {
  config: ServerConfig;
  nest: Nest;
  registry: DeviceRegistry;
  transfers: Transfers;
  preferences: Preferences;
  streams: Set<ServerResponse>;
  lanPort: () => number;
  publish: (type: 'devices-changed', slugs?: string[]) => void;
}

interface Request {
  hub: DeviceHub;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
}
type Handler = (r: Request) => Promise<unknown> | unknown;
interface Route {
  method: 'GET' | 'POST' | '*';
  path: RegExp;
  handle: Handler;
}

/** A body sent with a status other than 200. */
class WithStatus {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
const withStatus = (status: number, body: unknown) => new WithStatus(status, body);
const reply = (r: Request, status: number, value: unknown) => sendJson(r.res, status, value, r.hub.preferences.lang);
const route = (method: Route['method'], path: string, handle: Handler): Route => ({
  method,
  path: new RegExp(`^${path}$`),
  handle,
});
const ID = '([^/]+)';
const TASK_ID = '([a-f0-9-]+)';
const TRANSFER_ID = '([a-f0-9]{64})';

// ---------------------------------------------------------------- preferences

async function setLanguage({ hub, req }: Request) {
  const body = await readBody(req, KiB, 'Language request too large');
  let lang: unknown;
  try {
    lang = (JSON.parse(body) as { lang?: unknown } | null)?.lang;
  } catch {
    throw new HttpError(400, 'Invalid language');
  }
  if (!isLanguage(lang)) throw new HttpError(400, 'Invalid language');
  await hub.preferences.setLanguage(lang);
  hub.publish('devices-changed');
  return { lang };
}

// ---------------------------------------------------------------- DSH control surface

/** Run a device tool for DSH. If DSH hangs up first, the task is cancelled rather than left running. */
async function callTool({ hub, req, res }: Request) {
  const { name, args, sessionId } = await readJsonObject(req, 1024 * KiB, 'Device arguments too large');
  const target = typeof name === 'string' ? hub.registry.resolve(name) : undefined;
  if (!target) throw new HttpError(404, `Unknown device tool ${String(name)}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, 'Expected object arguments');
  const { device, tool } = target;
  if (!device.online) {
    throw new HttpError(409, `device ${device.slug} is offline (last seen ${device.lastSeen ?? 'unknown'})`);
  }
  let taskId: string | undefined;
  let abandoned = res.destroyed;
  const closed = () => {
    if (res.writableEnded) return;
    abandoned = true;
    if (taskId) void hub.nest.tasks.cancel(taskId);
  };
  res.once('close', closed);
  try {
    if (abandoned) return;
    const caller = { id: `dsh:${typeof sessionId === 'string' ? sessionId : 'unknown'}`, name: 'DSH chat' };
    const task = await hub.nest.call(tool.name, args as Record<string, unknown>, caller);
    taskId = task.id;
    if (abandoned) {
      await hub.nest.tasks.cancel(task.id);
      return;
    }
    return task;
  } finally {
    res.off('close', closed);
  }
}

function existingTask({ hub, params }: Request): string {
  const id = params[0]!;
  if (!hub.nest.tasks.get(id)) throw new HttpError(404, 'Not found');
  return id;
}

// ---------------------------------------------------------------- transfers (both callers)

/** Transfer failures are conflicts the owner can act on: answer 409 and keep their code. */
async function asConflict(run: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(409, message, (error as { code?: string }).code);
  }
}

function transferRoutes(base: string): Route[] {
  return [
    route('GET', `${base}/transfers`, ({ hub }) => hub.transfers.list()),
    route('POST', `${base}/transfers`, async (r) => {
      // Transfers.start validates the request's shape itself.
      const request = await readJsonObject(r.req, 32 * KiB, 'Transfer request too large');
      return withStatus(202, await asConflict(() => r.hub.transfers.start(request as unknown as TransferRequest)));
    }),
    route('POST', `${base}/transfers/${TRANSFER_ID}/(pause|resume|cancel|retry)`, (r) =>
      asConflict(() => r.hub.transfers.action(r.params[0]!, r.params[1] as 'pause' | 'resume' | 'cancel' | 'retry')),
    ),
    route('*', `${base}/transfers(?:/.*)?`, () => {
      throw new HttpError(404, 'Unknown transfer route');
    }),
  ];
}

// ---------------------------------------------------------------- owner API

function auditLimit(url: URL): number {
  const limit = Number(url.searchParams.get('limit') ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'limit must be 1-1000');
  return limit;
}

async function openLive({ hub, url }: Request) {
  const device = hub.registry.list().find((d) => d.device === url.searchParams.get('device'));
  if (!device?.paired || !device.online) throw new HttpError(409, 'Device is offline');
  const maxDimension = Number(url.searchParams.get('maxDimension') ?? 1280);
  const displayId = url.searchParams.get('displayId') ?? '';
  try {
    return await hub.nest.openOwnerStream(device.device, { maxDimension, displayId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(409, message, (error as { code?: string }).code);
  }
}

/** The address a phone on the LAN should dial: the bound host, or the first external IPv4 when bound to all. */
function pairingAddress(config: ServerConfig): string {
  const bound = config.devices.host;
  if (bound !== '0.0.0.0' && bound !== '::') return bound;
  const external = Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === 'IPv4' && !a.internal);
  return external?.address ?? config.host;
}

function startPairing({ hub }: Request) {
  const address = pairingAddress(hub.config);
  const host = address.includes(':') ? `[${address}]` : address;
  const port = hub.lanPort();
  return {
    ...hub.nest.pairing.start(),
    address,
    port,
    url: `ws://${host}:${port}/swiftnest`,
    fingerprint: hub.nest.identity.fingerprint,
  };
}

async function decideApproval({ hub, params }: Request) {
  const [id, action] = params as [string, 'approve' | 'deny'];
  if (hub.nest.tasks.get(id)?.state !== 'pending_approval') throw new HttpError(409, 'Approval is no longer pending');
  return action === 'approve' ? hub.nest.tasks.approve(id, 'App owner') : hub.nest.tasks.deny(id, 'denied by owner');
}

// ---------------------------------------------------------------- table

const routes: Route[] = [
  route('GET', `${PREFIX}/preferences`, ({ hub }) => ({
    lang: hub.preferences.lang,
    assistantName: hub.config.assistantName,
  })),
  route('POST', `${PREFIX}/preferences`, setLanguage),
  route('*', `${PREFIX}/preferences`, () => {
    throw new HttpError(405, 'Method not allowed');
  }),

  route('GET', CONTROL, ({ hub }) => hub.registry.snapshot()),
  route('GET', `${CONTROL}/events`, ({ hub, res }) => {
    const slugs = hub.registry.snapshot().devices.map((d) => d.slug);
    openEventStream(res, hub.streams, { type: 'devices-changed', slugs });
  }),
  route('POST', `${CONTROL}/call`, callTool),
  route('GET', `${CONTROL}/tasks/${TASK_ID}`, (r) => r.hub.nest.tasks.wait(existingTask(r), 25_000)),
  route('POST', `${CONTROL}/tasks/${TASK_ID}/cancel`, (r) => r.hub.nest.tasks.cancel(existingTask(r))),
  ...transferRoutes(CONTROL),

  ...transferRoutes(PREFIX),
  route('GET', `${PREFIX}/?`, ({ hub }) => hub.registry.list()),
  route('GET', `${PREFIX}/approvals`, ({ hub }) => hub.nest.tasks.list({ state: 'pending_approval' })),
  route('GET', `${PREFIX}/pairing`, ({ hub }) =>
    hub.nest.pairing.pending().map(({ id, device, fingerprint }) => ({ id, device, fingerprint })),
  ),
  route('GET', `${PREFIX}/audit`, ({ hub, url }) => hub.nest.audit.query({ limit: auditLimit(url) })),
  route('GET', `${PREFIX}/events`, ({ hub, res }) => openEventStream(res, hub.streams, { type: 'devices-changed' })),
  route('POST', `${PREFIX}/live`, openLive),
  route('POST', `${PREFIX}/pairing`, startPairing),
  route('POST', `${PREFIX}/pairing/${ID}/(approve|deny)`, ({ hub, params }) => {
    const id = decodeURIComponent(params[0]!);
    return withStatus(hub.nest.pairing.confirm(id, params[1] === 'approve') ? 200 : 409, { id });
  }),
  route('POST', `${PREFIX}/approvals/${ID}/(approve|deny)`, (r) =>
    decideApproval({ ...r, params: [decodeURIComponent(r.params[0]!), r.params[1]!] }),
  ),
  route('POST', `${PREFIX}/revoke/${ID}`, async ({ hub, params }) => {
    const device = decodeURIComponent(params[0]!);
    return withStatus((await hub.nest.revoke(device)) ? 200 : 404, { device });
  }),
];

export async function handleDeviceRequest(hub: DeviceHub, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const request: Request = { hub, req, res, url, params: [] };
  try {
    for (const { method, path, handle } of routes) {
      if (method !== '*' && method !== req.method) continue;
      const match = path.exec(url.pathname);
      if (!match) continue;
      // A handler returns the 200 body, a WithStatus, or nothing once it has answered itself
      // (an event stream) or the caller has gone.
      const result = await handle({ ...request, params: match.slice(1) });
      if (res.headersSent || res.destroyed) return;
      return result instanceof WithStatus ? reply(request, result.status, result.body) : reply(request, 200, result);
    }
    reply(request, 404, { error: 'Not found' });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (!res.headersSent)
      reply(request, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
}
