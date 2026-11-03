/** The Nest and its two loopback surfaces belong to the parent, never the DSH child. */
import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Nest,
  JsonDeviceStore,
  JsonlAuditLog,
  loadOrCreateIdentity,
  RulePolicy,
  text,
  fingerprintOf,
} from '@swiftnest/core';
import { WebSocketServer } from 'ws';
import { binaryPeer, serveLan } from '@swiftnest/link-lan';
import { serveMcpHttp } from '@swiftnest/surface-mcp';
import type { DeviceEvent } from '@swiftnest/api';
import type { ServerConfig } from './config.js';
import { DeviceRegistry } from './device-registry.js';
import { sendJson } from './device-response.js';
import { handleDeviceRequest, PREFIX, type DeviceHub } from './device-routes.js';
import { hasBearer } from './http.js';
import { installPlugins } from './plugin-install.js';
import { PluginManager, type PluginManagerDeps } from './plugin-manager.js';
import { Preferences } from './preferences.js';
import { Transfers } from './transfers.js';
import { NativePairings } from '@swiftnest/server-bundle/native-pairings-store';
import { handleNativePairing } from './native-pairings.js';

export const MCP_TOKEN_ENV = 'SWIFTNEST_DEVICES_MCP_TOKEN';
export const ADMIN_TOKEN_ENV = 'SWIFTNEST_DEVICES_ADMIN_TOKEN';
export const ADMIN_URL_ENV = 'SWIFTNEST_DEVICES_ADMIN_URL';
const secret = () => randomBytes(32).toString('base64url');

async function openNest(dir: string): Promise<Nest> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return new Nest({
    identity: await loadOrCreateIdentity(join(dir, 'identity.pem')),
    devices: await JsonDeviceStore.open(join(dir, 'paired.json')),
    audit: new JsonlAuditLog(join(dir, 'audit.jsonl')),
    policy: new RulePolicy(),
  });
}

/** Push a change notice to every open event stream; a stream that cannot keep up is dropped. */
function publisher(streams: Set<ServerResponse>) {
  return (type: DeviceEvent['type'], slugs?: string[]) => {
    for (const res of streams) {
      if (!res.write(`data: ${JSON.stringify({ type, slugs })}\n\n`)) res.destroy();
    }
  };
}

/**
 * The loopback API for the owner bundle and DSH. The authenticated bundle is the only caller:
 * refuse browsers (any Origin) and never trust forwarded identities.
 */
function adminServer(hub: DeviceHub, adminToken: string) {
  const { nest, preferences } = hub;
  const admin = createServer((req, res) => {
    const deny = (status: number, error: string) => sendJson(res, status, { error }, preferences.lang);
    if (!hasBearer(req, adminToken)) return deny(401, 'Unauthorized');
    if (req.headers.origin) return deny(403, 'Forbidden');
    const handle = req.url?.startsWith('/swiftnest/control/native/') ? handleNativePairing : handleDeviceRequest;
    handle(hub, req, res).catch((error) => {
      nest.logger.error(text('deviceApiFailedLog'), error);
      if (res.headersSent) res.destroy();
      else deny(500, 'Device API failed');
    });
  });
  // Live view frames travel over a WebSocket on the same port.
  const bulk = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  admin.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!hasBearer(req, adminToken) || req.headers.origin || url.pathname !== `${PREFIX}/live`) return socket.destroy();
    bulk.handleUpgrade(req, socket, head, (ws) =>
      nest.streams.attachOwner(url.searchParams.get('id') ?? '', binaryPeer(ws)),
    );
  });
  return { admin, bulk };
}

export interface StartDevicesOptions {
  /** Restart the DSH kernel so plugin changes take effect; a hub without a kernel has nothing to restart. */
  restartKernel?: () => Promise<void>;
  /** The kernel could not start even with the previous plugins. */
  kernelFailed?: (error: unknown) => void;
  installPlugins?: PluginManagerDeps['install'];
}

export async function startDevices(config: ServerConfig, options: StartDevicesOptions = {}) {
  const dir = join(config.home, 'devices');
  const nest = await openNest(dir);
  const preferences = await Preferences.open(join(config.home, 'preferences.json'), config.lang ?? 'zh-CN');
  const nativePairings = new NativePairings(join(config.home, 'native-pairings.json'));
  const registry = await DeviceRegistry.open(nest, join(dir, 'seen.json'), () => preferences.lang);
  const streams = new Set<ServerResponse>();
  const publish = publisher(streams);
  const quota = config.files?.quotaBytes ?? 100 * 1024 ** 3;
  const transfers = await Transfers.open(nest, config.home, quota, () => publish('transfers-changed'));

  const refresh = () => {
    for (const record of nativePairings.list()) {
      if (
        record.device &&
        !nest.devicesStore
          .list()
          .some((d) => d.device === record.device && fingerprintOf(d.publicKey) === record.fingerprint)
      )
        nativePairings.revoke(record.device);
    }
    publish('devices-changed', registry.refresh());
  };
  const offTools = nest.onToolsChanged(refresh);
  const offEvents = [
    nest.devicesStore.onChange?.(refresh),
    nest.tasks.onChange((s) => publish(s.state === 'pending_approval' ? 'approval-pending' : 'approvals-changed')),
    nest.pairing.onChange(() => publish('pairing-changed')),
  ];
  refresh();

  const mcpToken = secret();
  const adminToken = secret();
  let lan: Awaited<ReturnType<typeof serveLan>> | undefined;
  let mcp: Awaited<ReturnType<typeof serveMcpHttp>> | undefined;
  const plugins = new PluginManager(config, {
    install: options.installPlugins ?? installPlugins,
    restart: options.restartKernel ?? (async () => {}),
    fail: options.kernelFailed ?? (() => {}),
    changed: () => publish('plugins-changed'),
    log: (line) => console.log(line),
  });
  const hub: DeviceHub = {
    config,
    nativePairings,
    nest,
    registry,
    transfers,
    preferences,
    plugins,
    streams,
    publish,
    lanPort: () => lan!.port,
  };

  const { admin, bulk } = adminServer(hub, adminToken);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      await transfers.close();
      for (const off of offEvents) off?.();
      nest.pairing.stop();
      for (const p of nest.pairing.pending()) nest.pairing.confirm(p.id, false);
      for (const t of nest.tasks.list()) {
        if (['pending_approval', 'queued', 'running'].includes(t.state)) await nest.tasks.cancel(t.id);
      }
      for (const res of streams) res.end();
      for (const ws of bulk.clients) ws.terminate();
      bulk.close();
      const closed = new Promise<void>((resolve) => admin.close(() => resolve()));
      admin.closeAllConnections();
      await closed;
      await mcp?.close();
      await lan?.close();
      await nest.close();
      // Devices going offline during shutdown still reach the registry, so it stops listening last.
      offTools();
      await registry.flush();
      await preferences.flush();
      await plugins.flush();
    })());

  try {
    lan = await serveLan(nest, {
      host: config.devices.host,
      port: config.devices.port,
      advertise: config.devices.mdns,
    });
    mcp = await serveMcpHttp(nest, { host: '127.0.0.1', port: 0, bearerToken: mcpToken });
    await new Promise<void>((resolve, reject) => {
      admin.once('error', reject);
      admin.listen(0, '127.0.0.1', resolve);
    });
    const port = (admin.address() as { port: number }).port;
    return {
      nest,
      plugins,
      mcpUrl: mcp.url,
      lanUrl: lan.url,
      env: { [MCP_TOKEN_ENV]: mcpToken, [ADMIN_TOKEN_ENV]: adminToken, [ADMIN_URL_ENV]: `http://127.0.0.1:${port}` },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
