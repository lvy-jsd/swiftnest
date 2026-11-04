import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  channelPublicKey,
  joinRelay,
  relayConfig,
  relayServerId,
  relaySocketUrl,
  type ChannelIdentity,
  type RelayConfig,
  type ChannelPairing,
} from '@swiftnest/channel';
import { channelAddresses } from './trusted-proxy.js';

/** Two spare outbound sockets; each becomes exactly one end-to-end Noise channel. */
export class ServerRelay {
  config?: RelayConfig;
  connected = false;
  private generation = 0;
  private sockets = new Set<WebSocket>();
  private registered = new Set<WebSocket>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private writes = Promise.resolve();
  constructor(
    private home: string,
    private identity: ChannelIdentity,
    private accept: (socket: WebSocket) => Promise<void>,
  ) {}
  async load(fallback?: RelayConfig) {
    let value: unknown = fallback;
    try {
      value = JSON.parse(await readFile(join(this.home, 'relay.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.configure(relayConfig(value));
  }
  save(value: unknown): Promise<void> {
    const config = relayConfig(value);
    const write = this.writes.then(async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const file = join(this.home, 'relay.json');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(config ?? null), { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.configure(config);
    });
    this.writes = write.catch(() => {});
    return write;
  }
  private configure(config?: RelayConfig) {
    this.close();
    this.config = config;
    if (config) for (let slot = 0; slot < 2; slot++) void this.dial(this.generation);
  }
  private retry(generation: number) {
    if (generation !== this.generation) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        void this.dial(generation);
      },
      2000 + Math.random() * 1000,
    );
    this.timers.add(timer);
  }
  private async dial(generation: number) {
    const config = this.config;
    if (!config || generation !== this.generation) return;
    const wire = new WebSocket(relaySocketUrl(config.address), { maxPayload: 128 * 1024, handshakeTimeout: 10000 });
    this.sockets.add(wire);
    wire.on('error', () => wire.terminate());
    wire.once('close', () => {
      this.sockets.delete(wire);
      this.registered.delete(wire);
      this.connected = this.registered.size > 0;
    });
    let paired = false;
    try {
      // Waiting for an App is intentionally unbounded; close() cancels the socket.
      const id = await relayServerId(channelPublicKey(this.identity));
      await joinRelay(
        wire,
        { role: 'server', id, secret: config.secret },
        new AbortController().signal,
        () => {
          this.registered.add(wire);
          this.connected = true;
        },
        async () => {
          if (generation !== this.generation) return wire.terminate();
          paired = true;
          void this.dial(generation);
          await this.accept(wire);
        },
      );
    } catch {
      wire.terminate();
      if (!paired) this.retry(generation);
    }
  }
  pairing(lan: string): ChannelPairing {
    return {
      v: 1,
      key: channelPublicKey(this.identity),
      addresses: {
        lan: channelAddresses(lan),
        relay: this.config ? [this.config.address] : [],
      },
    };
  }
  close() {
    this.generation++;
    this.connected = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const wire of this.sockets) wire.terminate();
    this.sockets.clear();
    this.registered.clear();
  }
}
