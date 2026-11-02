import { localizedError, translateReason, translateMessage } from './i18n.js';
/** The Nest and its two loopback surfaces belong to the parent, never the DSH child. */
import { Transfers } from './transfers.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { Nest, JsonDeviceStore, JsonlAuditLog, loadOrCreateIdentity, RulePolicy, fingerprintOf, type ExposedTool } from '@swiftnest/core';
import { WebSocketServer } from 'ws';
import { binaryPeer, serveLan } from '@swiftnest/link-lan';
import { serveMcpHttp } from '@swiftnest/surface-mcp';
import type { Device, DeviceEvent } from '@swiftnest/api';
import type { ServerConfig } from './config.js';

export const MCP_TOKEN_ENV = 'SWIFTNEST_DEVICES_MCP_TOKEN';
export const ADMIN_TOKEN_ENV = 'SWIFTNEST_DEVICES_ADMIN_TOKEN';
export const ADMIN_URL_ENV = 'SWIFTNEST_DEVICES_ADMIN_URL';
const PREFIX = '/swiftnest/api/devices';
const secret = () => randomBytes(32).toString('base64url');

export async function startDevices(config: ServerConfig) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    const failure = value as { error?: string };
    if (status >= 400 && typeof failure?.error === 'string') {
      const details = localizedError({ ...failure, message: failure.error }, lang);
      value = { ...failure, ...details, error: details.message };
    }
    const present = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(present);
      if (!item || typeof item !== 'object') return item;
      const task = item as { state?: string; tool?: string; source?: unknown; destination?: unknown; failure?: {code:string;message:string;hint:string}; reason?: string; error?: unknown; result?: {text: string; untrusted?: boolean} };
      if (!task.state) return item;
      if (task.tool) return { ...task, ...(task.reason ? { reason: translateReason(task.reason, lang) } : {}),
        ...(task.error ? { error: { ...(task.error as object), ...localizedError(task.error, lang) } } : {}),
        ...(task.result && !task.result.untrusted ? { result: { ...task.result, text: translateMessage(task.result.text, lang) } } : {}) };
      if (task.source && task.destination && typeof task.error === 'string') {
        const failure = localizedError(task.failure ?? { message: task.error }, lang);
        return { ...task, error: failure.message, failure };
      }
      return item;
    };
    value = present(value);
    return res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
  };
  const dir = join(config.home, 'devices');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const nest = new Nest({
    identity: await loadOrCreateIdentity(join(dir, 'identity.pem')),
    devices: await JsonDeviceStore.open(join(dir, 'paired.json')),
    audit: new JsonlAuditLog(join(dir, 'audit.jsonl')),
    policy: new RulePolicy(),
  });
  type CachedDevice = Device & { tools?: ExposedTool[] };
  let cached: Record<string, CachedDevice> = {};
  const metadata = join(dir, 'seen.json');
  try { cached = JSON.parse(await readFile(metadata, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let lang: 'zh-CN' | 'en' = config.lang ?? 'zh-CN';
  const preferencesFile = join(config.home, 'preferences.json');
  try {
    const saved = JSON.parse(await readFile(preferencesFile, 'utf8'));
    if (saved?.lang === 'en' || saved?.lang === 'zh-CN') lang = saved.lang;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let preferenceWrites = Promise.resolve();
  // E1 stored only capability/tool names. Restore callable offline placeholders until
  // the next authenticated hello refreshes schemas and risk metadata.
  for (const d of Object.values(cached)) {
    d.online = false;
    d.tools ??= d.capabilities.flatMap(cap => cap.tools.map(name => ({
      name: `${d.device}__${cap.id}__${name}`, device: d.device, capability: cap.id,
      tool: { name, description: `Device ${cap.id}.${name} (metadata refreshes on reconnect)`, risk: 'sensitive' as const, defaultTimeoutMs: 30_000,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
    })));
  }
  let writes = Promise.resolve();
  const streams = new Set<ServerResponse>();
  const publish = (type: DeviceEvent['type'], slugs?: string[]) => {
    for (const res of streams) {
      if (!res.write(`data: ${JSON.stringify({ type, slugs })}\n\n`)) res.destroy();
    }
  };
  const transfers = await Transfers.open(nest, config.home, config.files?.quotaBytes ?? 100 * 1024 ** 3, () => publish("transfers-changed"));
  const list = (): Device[] => {
    const online = new Map(nest.devices().map(d => [d.device, d]));
    const paired = new Map(nest.devicesStore.list().map(d => [d.device, d]));
    return [...new Set([...paired.keys(), ...online.keys()])].filter(device => device !== 'server-files').map(device => {
      const live = online.get(device), stored = paired.get(device);
      return { ...cached[device], ...live, device, slug: stored?.slug, name: stored?.name ?? device, lastSeen: cached[device]?.lastSeen ?? stored?.pairedAt, kind: stored?.kind ?? 'desktop', online: !!live, paired: !!stored,
        fingerprint: live?.fingerprint ?? fingerprintOf(stored!.publicKey), pairedAt: stored?.pairedAt,
        capabilities: live?.capabilities ?? cached[device]?.capabilities ?? [] };
    });
  };
  const snapshot = () => ({
    devices: list().filter(d => d.paired).map(d => ({ slug: d.slug!, name: d.name!, kind: d.kind!, online: d.online, ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}) })),
    tools: list().filter(d => d.paired).flatMap(d => (cached[d.device]?.tools ?? []).filter(t=>t.capability!=="transfer").map(t => ({
      name: `device__${d.slug}__${t.capability}_${t.tool.name}`, slug: d.slug!,
      description: typeof t.tool.description === 'string' ? translateMessage(t.tool.description, lang) : (lang === "en" ? t.tool.description.en : t.tool.description.zh ?? t.tool.description.en),
      risk: t.tool.risk, inputSchema: t.tool.inputSchema,
    }))),
  });
  let previous = new Map(snapshot().devices.map(d => [d.slug, JSON.stringify(d)]));
  const changed = () => {
    const now = new Date().toISOString();
    const live = new Set(nest.devices().map(d => d.device));
    const next: Record<string, CachedDevice> = Object.create(null);
    const liveTools = nest.tools();
    for (const d of list().filter(d => d.paired || d.online)) {
      const tools = new Map((cached[d.device]?.tools ?? []).map(t => [t.name, t]));
      for (const t of liveTools.filter(t => t.device === d.device)) tools.set(t.name, t);
      next[d.device] = { ...d, tools: [...tools.values()], lastSeen: live.has(d.device) || cached[d.device]?.online ? now : d.lastSeen };
    }
    cached = next;
    const current = new Map(snapshot().devices.map(d => [d.slug, JSON.stringify(d)]));
    const slugs = [...new Set([...previous.keys(), ...current.keys()])].filter(slug => previous.get(slug) !== current.get(slug));
    previous = current;
    const data = JSON.stringify(cached);
    writes = writes.then(async () => {
      await writeFile(`${metadata}.tmp`, data, { mode: 0o600 });
      await rename(`${metadata}.tmp`, metadata);
    }).catch(error => nest.logger.error('device metadata write failed', error));
    publish('devices-changed', slugs);
  };
  const offTools = nest.onToolsChanged(changed);
  const offStore = nest.devicesStore.onChange?.(changed);
  changed();
  const offTasks = nest.tasks.onChange(s => publish(s.state === 'pending_approval' ? 'approval-pending' : 'approvals-changed'));
  const offPairing = nest.pairing.onChange(() => publish('pairing-changed'));
  const mcpToken = secret(), adminToken = secret();
  let lan: Awaited<ReturnType<typeof serveLan>> | undefined;
  let mcp: Awaited<ReturnType<typeof serveMcpHttp>> | undefined;
  const admin = createServer((req, res) => {
    void (async () => {
      const expected = Buffer.from(`Bearer ${adminToken}`), given = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return void json(res, 401, { error: 'Unauthorized' });
      // The authenticated bundle is the only caller. Never trust a forwarded target or identity.
      if (req.headers.origin) return void json(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === `${PREFIX}/preferences`) {
        if (req.method === 'GET') return void json(res, 200, { lang });
        if (req.method === 'POST') {
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) return void json(res, 413, { error: 'Language request too large' }); }
          let value; try { value = JSON.parse(body); } catch { return void json(res, 400, { error: 'Invalid language' }); }
          if (!value || typeof value !== 'object' || (value.lang !== 'en' && value.lang !== 'zh-CN')) return void json(res, 400, { error: 'Invalid language' });
          const selected = value.lang as 'en' | 'zh-CN';
          const write = preferenceWrites.then(async () => {
            await writeFile(`${preferencesFile}.tmp`, JSON.stringify({ lang: selected }), { mode: 0o600 });
            await rename(`${preferencesFile}.tmp`, preferencesFile);
            lang = selected;
            publish('devices-changed');
          });
          preferenceWrites = write.catch(() => {});
          await write;
          return void json(res, 200, { lang: selected });
        }
        return void json(res, 405, { error: 'Method not allowed' });
      }
      // Private control routes are never mounted in the owner-facing proxy.
      const control = '/swiftnest/control/devices';
      if (url.pathname === control && req.method === 'GET') return void json(res, 200, snapshot());
      if (url.pathname === `${control}/events` && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        streams.add(res);
        res.write(`data: ${JSON.stringify({ type: 'devices-changed', slugs: snapshot().devices.map(d => d.slug) })}\n\n`);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
        res.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
        return;
      }
      if (url.pathname === `${control}/call` && req.method === 'POST') {
        let body = ''; for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 1024 * 1024) return void json(res, 413, { error: 'Device arguments too large' });
        }
        const { name, args, sessionId } = JSON.parse(body);
        const tool = snapshot().tools.find(t => t.name === name);
        if (!tool) return void json(res, 404, { error: `Unknown device tool ${name}` });
        if (!args || typeof args !== 'object' || Array.isArray(args)) return void json(res, 400, { error: 'Expected object arguments' });
        const d = list().find(d => d.slug === tool.slug)!;
        if (!d.online) return void json(res, 409, { error: `device ${d.slug} is offline (last seen ${d.lastSeen ?? 'unknown'})` });
        const raw = cached[d.device]!.tools!.find(t => `device__${d.slug}__${t.capability}_${t.tool.name}` === name)!;
        let taskId: string | undefined;
        let abandoned = res.destroyed;
        const closed = () => {
          if (res.writableEnded) return;
          abandoned = true;
          if (taskId) void nest.tasks.cancel(taskId);
        };
        res.once('close', closed);
        try {
          if (abandoned) return;
          const task = await nest.call(raw.name, args, { id: `dsh:${typeof sessionId === 'string' ? sessionId : 'unknown'}`, name: 'DSH chat' });
          taskId = task.id;
          if (abandoned) { await nest.tasks.cancel(task.id); return; }
          return void json(res, 200, task);
        } finally { res.off('close', closed); }
      }
      const taskRoute = new RegExp(`^${control}/tasks/([a-f0-9-]+)(/cancel)?$`).exec(url.pathname);
      if (taskRoute && nest.tasks.get(taskRoute[1]!)) {
        if (req.method === 'POST' && taskRoute[2]) return void json(res, 200, await nest.tasks.cancel(taskRoute[1]!));
        if (req.method === 'GET' && !taskRoute[2]) return void json(res, 200, await nest.tasks.wait(taskRoute[1]!, 25_000));
      }
      // Both routes are owner-authorized: the public one by the bundle, the private one by its bearer.
      const transferPath = url.pathname.startsWith(control + '/transfers') ? url.pathname.slice(control.length) : url.pathname.startsWith(PREFIX + '/transfers') ? url.pathname.slice(PREFIX.length) : '';
      if (transferPath) {
        try {
          if (transferPath === '/transfers' && req.method === 'GET') return void json(res, 200, transfers.list());
          if (transferPath === '/transfers' && req.method === 'POST') {
            let body='';for await (const chunk of req) { body+=chunk; if(Buffer.byteLength(body)>32768)return void json(res,413,{error:'Transfer request too large'}); }
            return void json(res,202,await transfers.start(JSON.parse(body)));
          }
          const action=/^\/transfers\/([a-f0-9]{64})\/(pause|resume|cancel|retry)$/.exec(transferPath);
          if (action && req.method === 'POST') return void json(res,200,await transfers.action(action[1]!,action[2] as 'pause'|'resume'|'cancel'|'retry'));
          return void json(res,404,{error:'Unknown transfer route'});
        } catch(error) { return void json(res,409,{error:error instanceof Error ? error.message : String(error),code:(error as {code?:string}).code}); }
      }
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
      if (req.method === 'POST' && path === '/live') {
        const device = list().find(d => d.device === url.searchParams.get('device'));
        if (!device?.paired || !device.online) return void json(res, 409, { error: 'Device is offline' });
        const maxDimension = Number(url.searchParams.get('maxDimension') ?? 1280);
        const displayId = url.searchParams.get('displayId') ?? '';
        try { return void json(res, 200, await nest.openOwnerStream(device.device, { maxDimension, displayId })); }
        catch (error) { return void json(res, 409, { error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code }); }
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
            return void json(res, 200, action === 'approve' ? await nest.tasks.approve(id, 'App owner') : await nest.tasks.deny(id, 'denied by owner'));
          }
        }
      }
      json(res, 404, { error: 'Not found' });
    })().catch(error => { nest.logger.error('device API failed', error); if (!res.headersSent) json(res, 500, { error: 'Device API failed' }); else res.destroy(); });
  });
  const bulk = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  admin.on('upgrade', (req, socket, head) => {
    const expected = Buffer.from(`Bearer ${adminToken}`), given = Buffer.from(req.headers.authorization ?? '');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (expected.length !== given.length || !timingSafeEqual(expected, given) || req.headers.origin || url.pathname !== `${PREFIX}/live`) return socket.destroy();
    bulk.handleUpgrade(req, socket, head, ws => { nest.streams.attachOwner(url.searchParams.get('id') ?? '', binaryPeer(ws)); });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    await transfers.close();
    offTasks(); offPairing(); offStore?.();
    nest.pairing.stop();
    for (const p of nest.pairing.pending()) nest.pairing.confirm(p.id, false);
    for (const t of nest.tasks.list()) if (['pending_approval', 'queued', 'running'].includes(t.state)) await nest.tasks.cancel(t.id);
    for (const res of streams) res.end();
    for (const ws of bulk.clients) ws.terminate();
    bulk.close();
    const done = new Promise<void>(resolve => admin.close(() => resolve()));
    admin.closeAllConnections();
    await done;
    await mcp?.close();
    await lan?.close();
    await nest.close();
    offTools();
    await writes; await preferenceWrites;
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
