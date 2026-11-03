/**
 * swiftnest-core: the first built-in module. It adds health and App routes; DSH's own
 * routes and Web UI stay untouched.
 *
 * `GET /swiftnest/health` answers without authentication and reveals nothing
 * private: versions and whether the configured model endpoint answers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deviceProxy, liveUpgrade, OWNER_PREFIXES, type DeviceConnection } from './devices.js';
import { appHandler } from './app.js';
import { CHANNEL_PATH } from '@swiftnest/channel';
import { loadChannelIdentity } from './channel-identity.js';
import { appChannel } from './channel.js';
import { nativePairings, type NativeConnection } from './native-pairings.js';

export const name = 'swiftnest-core';
export const inject = ['webServer', 'connection'];

export interface CoreConfig {
  version?: string;
  modelBaseUrl?: string;
  appDist?: string;
  home?: string;
  devicesAdminUrl?: string;
  devicesAdminToken?: string;
}

interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

interface CoreContext {
  connection?: DeviceConnection;
  webServer: {
    getOrigin?(): string;
    register(route: WebRoute): () => void;
    registerUpgrade(route: {
      path: string;
      handler(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void;
    }): () => void;
  };
  effect(fn: () => () => void, label?: string): void;
}

export interface Health {
  ok: true;
  swiftnest: string;
  dsh: string;
  model: { configured: boolean; reachable: boolean | null };
}

/** How long the health route waits for the model endpoint before reporting it unreachable. */
const MODEL_PROBE_TIMEOUT_MS = 2000;

export async function probeModel(
  baseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  if (!baseUrl) return null;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
    });
    // Some OpenAI-compatible gateways do not implement /models; any answer below 500 means the server is up.
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function health(config: CoreConfig, dshVersion: string, fetchImpl?: typeof fetch): Promise<Health> {
  return {
    ok: true,
    swiftnest: config.version ?? 'dev',
    dsh: dshVersion,
    model: { configured: Boolean(config.modelBaseUrl), reachable: await probeModel(config.modelBaseUrl, fetchImpl) },
  };
}

function ownerRoutes(ctx: CoreContext, config: CoreConfig): void {
  if (!config.devicesAdminUrl || !config.devicesAdminToken) return;
  if (!ctx.connection) throw new Error('Devices require owner session admission');
  const native = config.home
    ? nativePairings(ctx.connection as NativeConnection, config.home, config.devicesAdminUrl, config.devicesAdminToken)
    : undefined;
  if (native) {
    ctx.effect(() => () => native.close(), 'swiftnest-core: native credentials');
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/swiftnest/native', handler: native.handler }),
      'swiftnest-core: native pairing',
    );
  }
  const handler = deviceProxy(ctx.connection, config.devicesAdminUrl, config.devicesAdminToken, native?.invalidate);
  const live = liveUpgrade(ctx.connection, config.devicesAdminUrl, config.devicesAdminToken);
  ctx.effect(() => {
    const off = ctx.webServer.registerUpgrade({ path: '/swiftnest/api/devices/live', handler: live.handler });
    return () => {
      off();
      live.close();
    };
  }, 'swiftnest-core: live');
  for (const path of OWNER_PREFIXES)
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }), `swiftnest-core: ${path}`);
}

export async function apply(ctx: CoreContext, config: CoreConfig = {}): Promise<void> {
  ownerRoutes(ctx, config);
  if (config.home && ctx.connection && ctx.webServer.getOrigin) {
    const channel = appChannel(
      await loadChannelIdentity(config.home),
      () => ctx.webServer.getOrigin!(),
      ctx.connection,
    );
    ctx.effect(() => {
      const off = ctx.webServer.registerUpgrade({ path: CHANNEL_PATH, handler: channel.handler });
      return () => {
        off();
        channel.close();
      };
    }, 'swiftnest-core: encrypted App channel');
  }
  const handler = appHandler(config.appDist);
  // DSH prefix paths have no trailing slash and match both /app and /app/*.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/app', handler }), 'swiftnest-core: /app');
  const dshVersion = process.env.SWIFTNEST_DSH_VERSION ?? 'unknown';
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/swiftnest/health',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405).end();
            return;
          }
          const body = JSON.stringify(await health(config, dshVersion));
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
        },
      }),
    'swiftnest-core: /swiftnest/health',
  );
}
