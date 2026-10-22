/**
 * link-lan: devices on the same network find the Nest with mDNS and connect over WebSocket (design §6).
 *
 * The WebSocket itself is plain `ws://`: what makes it safe is the secure channel from @swiftnest/core that runs on top
 * (mutual Ed25519 authentication, AES-256-GCM), the same on every link. An unpaired device gets no further than the
 * handshake; the Nest caps how many handshakes may be in flight.
 *
 *   Nest   serveLan(nest)            — or install the plugin: `nest.use(lan, { port })`
 *   Perch  runLanPerch(perch, {...}) — discover or dial, pair if asked, stay connected, reconnect with backoff
 */
import { acceptPerch, connectToNest, definePlugin, fingerprintOf, SwiftnestFailure, type ConnectOptions, type FrameTransport, type Identity, type Logger, type Nest, type NestSession, type Perch } from "@swiftnest/core";
import { WebSocket, WebSocketServer } from "ws";
import { advertise, discover, type DiscoveredNest } from "./mdns.js";

export { advertise, discover, type DiscoveredNest } from "./mdns.js";

export const DEFAULT_PORT = 7711;
export const DEFAULT_PATH = "/swiftnest";
const MAX_FRAME = 16 * 1024 * 1024;

/** A WebSocket as a channel transport. Close reasons carry Swiftnest error codes (e.g. NOT_PAIRED). */
export function wsTransport(ws: WebSocket): FrameTransport {
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    onMessage(fn) {
      const h = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (!isBinary) fn(data.toString());
      };
      ws.on("message", h);
      return () => ws.off("message", h);
    },
    onClose(fn) {
      const h = (_code: number, reason: Buffer) => fn(reason.toString() || undefined);
      ws.on("close", h);
      return () => ws.off("close", h);
    },
    close: (reason) => ws.close(4000, (reason ?? "").slice(0, 120)),
  };
}

// ---------------------------------------------------------------- Nest side

export interface LanNestOptions {
  /** Default 0.0.0.0: reachable from the LAN (only paired devices get past the handshake). */
  host?: string;
  port?: number;
  path?: string;
  /** Answer mDNS queries so devices find this Nest without an address. Default true. */
  advertise?: boolean;
  /** Connections allowed in the unauthenticated handshake phase at once. Default 16. */
  maxHandshakes?: number;
  logger?: Logger;
}

export interface LanServer {
  port: number;
  /** ws:// URL on the bound host (0.0.0.0 shows as the first LAN address in logs, but devices dial their own). */
  url: string;
  close(): Promise<void>;
}

export async function serveLan(nest: Nest, o: LanNestOptions = {}): Promise<LanServer> {
  const host = o.host ?? "0.0.0.0";
  const path = o.path ?? DEFAULT_PATH;
  const logger = o.logger ?? nest.logger.child("lan");
  const maxHandshakes = o.maxHandshakes ?? 16;
  let handshakes = 0;
  const wss = new WebSocketServer({ host, port: o.port ?? DEFAULT_PORT, path, maxPayload: MAX_FRAME });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", (e) => reject(e.message.includes("EADDRINUSE") ? new SwiftnestFailure("PORT_IN_USE", `Port ${o.port ?? DEFAULT_PORT} is already in use.`, "Stop the other program or pick another port with --lan-port.") : e));
  });
  const port = (wss.address() as { port: number }).port;

  wss.on("connection", (ws, req) => {
    if (handshakes >= maxHandshakes) return ws.close(4029, "BUSY");
    handshakes++;
    let counted = true;
    const release = () => {
      if (counted) handshakes--;
      counted = false;
    };
    ws.on("close", release);
    acceptPerch(nest, wsTransport(ws), { via: "lan", logger })
      .then((conn) => {
        release();
        logger.info(`${conn.device} connected from ${req.socket.remoteAddress}`);
      })
      .catch((e: unknown) => {
        release();
        const err = SwiftnestFailure.from(e, "HANDSHAKE_FAILED");
        logger.warn(`connection from ${req.socket.remoteAddress} refused: ${err.code} ${err.message}`);
        if (ws.readyState === WebSocket.OPEN) ws.close(4000, err.code);
      });
  });

  const mdns = o.advertise === false ? undefined : advertise({ port, path, fingerprint: nest.identity.fingerprint });
  return {
    port,
    url: `ws://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}${path}`,
    close: async () => {
      mdns?.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------- Perch side

export type PerchState = "searching" | "connecting" | "pairing" | "online" | "offline" | "stopped";

export interface LanPerchOptions {
  /** ws://host:port/swiftnest — skips discovery. */
  url?: string;
  /** Where the Nest was last time: dialled when discovery finds nothing (e.g. a firewall drops mDNS). */
  lastUrl?: string;
  identity?: Identity;
  /** The pinned Nest key. Without it, `pairing` is required. */
  nestKey?: string;
  pairing?: ConnectOptions["pairing"];
  /** Pairing done: store the Nest key (and the URL that worked) before the session continues. */
  onPaired?(nestKey: string, url: string): void | Promise<void>;
  onStatus?(state: PerchState, detail?: string): void;
  /** Keep reconnecting after a drop (default true). */
  reconnect?: boolean;
  discoverTimeoutMs?: number;
  logger?: Logger;
}

/** Codes after which retrying cannot help: the person has to act. */
const FINAL = new Set(["REVOKED", "NOT_PAIRED", "NEST_KEY_CHANGED", "DEVICE_DISCONNECTED", "PAIRING_REJECTED", "PAIRING_CLOSED", "DEVICE_NAME_TAKEN", "PROTOCOL_MISMATCH", "MULTIPLE_NESTS"]);

export interface LanPerchRun {
  /** Disconnect now and stop reconnecting ("立即断开"). */
  stop(): void;
  /** Resolves once the run ends for good, with the reason. */
  finished: Promise<{ code: string; message: string }>;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: MAX_FRAME });
    ws.once("open", () => resolve(ws));
    ws.once("error", (e) => reject(new SwiftnestFailure("NEST_UNREACHABLE", `Cannot reach the Nest at ${url}: ${e.message}`, "Check that the Nest is running and both machines are on the same network.", true)));
  });
}

async function locate(o: LanPerchOptions): Promise<string | undefined> {
  if (o.url) return o.url;
  const found = await discover(o.discoverTimeoutMs ?? 2_000);
  if (o.nestKey) return found.find((n) => n.fingerprint === fingerprintOf(o.nestKey!))?.url ?? o.lastUrl;
  if (!found.length) return o.lastUrl;
  if (found.length > 1) {
    throw new SwiftnestFailure("MULTIPLE_NESTS", `Found ${found.length} Nests on this network (${found.map((n) => n.fingerprint).join(", ")}).`, "Pass the one you mean with --nest ws://address:port/swiftnest.");
  }
  return found[0]?.url;
}

export function runLanPerch(perch: Perch, o: LanPerchOptions): LanPerchRun {
  const logger = o.logger ?? perch.logger.child("lan");
  const status = (s: PerchState, d?: string) => {
    logger.debug(`${s}${d ? `: ${d}` : ""}`);
    o.onStatus?.(s, d);
  };
  let stopped = false;
  let session: NestSession | undefined;
  let socket: WebSocket | undefined;
  let wake: (() => void) | undefined;
  let nestKey = o.nestKey;
  let pairing = o.pairing;
  let lastUrl = o.lastUrl;

  const finished = (async (): Promise<{ code: string; message: string }> => {
    let delay = 1_000;
    while (!stopped) {
      try {
        status("searching");
        const url = await locate({ ...o, nestKey, lastUrl });
        if (!url) throw new SwiftnestFailure("NEST_NOT_FOUND", "No Nest answered on this network.", "Start the Nest, or pass its address with --nest.", true);
        if (stopped) break;
        status("connecting", url);
        socket = await openSocket(url);
        if (pairing) status("pairing", url);
        session = await connectToNest(perch, wsTransport(socket), {
          identity: o.identity ?? perch.identity,
          nestKey,
          pairing,
          onPaired: async (key) => {
            nestKey = key;
            pairing = undefined; // pair once; reconnects use the pinned key
            await o.onPaired?.(key, url);
          },
        });
        delay = 1_000;
        lastUrl = url;
        status("online", url);
        const end = await session.closed;
        session = undefined;
        if (stopped || FINAL.has(end.code)) return end;
        status("offline", end.message);
      } catch (e) {
        const err = SwiftnestFailure.from(e, "CONNECT_FAILED");
        socket?.terminate();
        if (stopped) break;
        if (FINAL.has(err.code)) return { code: err.code, message: err.message };
        status("offline", err.message);
      }
      if (o.reconnect === false) return { code: "DISCONNECTED", message: "Not reconnecting." };
      await new Promise<void>((r) => {
        const timer = setTimeout(r, delay * (0.8 + Math.random() * 0.4));
        wake = () => {
          clearTimeout(timer);
          r();
        };
      });
      delay = Math.min(delay * 2, 30_000);
    }
    return { code: "DEVICE_DISCONNECTED", message: "Disconnected on this device." };
  })().finally(() => status("stopped"));

  return {
    stop() {
      stopped = true;
      session?.close();
      socket?.close();
      wake?.();
    },
    finished,
  };
}

/** Nest plugin: `nest.use(lan, { port, host, advertise })`. */
export default definePlugin({
  name: "@swiftnest/link-lan",
  kind: "link",
  apiVersion: 1,
  runsOn: "nest",
  async setup(ctx) {
    if (ctx.role !== "nest") return;
    const c = ctx.config as LanNestOptions;
    const server = await serveLan(ctx.nest, { ...c, logger: ctx.logger });
    ctx.logger.info(`listening on port ${server.port}`);
    return () => server.close();
  },
});
