import { Perch, memoryLink } from '@swiftnest/core';
import files from '@swiftnest/cap-files';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, connect as tcpConnect, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { SwiftnestClient, type ChannelPairing, type ClientOptions } from '@swiftnest/api';
import { loadConfig } from '../src/config.js';
import { startStableKernel } from './fixtures/kernel.js';
import { pairingUrl } from '../src/pairing.js';
import { testTls } from '../../client/test/fixtures/tls.js';
import { encodeBytes } from '@swiftnest/channel';

const secret = 's'.repeat(32);
async function relayProcess() {
  const child = fork(fileURLToPath(new URL('./fixtures/relay-process.mjs', import.meta.url)), {
    env: { ...process.env, SWIFTNEST_RELAY_SECRET: secret },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const [message] = (await once(child, 'message')) as [{ url: string }];
  return { child, url: message.url };
}
async function sniff(upstream: string) {
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  const proxy = createServer((socket) => {
    const target = tcpConnect(Number(new URL(upstream).port), '127.0.0.1');
    for (const wire of [socket, target]) {
      sockets.add(wire);
      wire.on('error', () => {});
      wire.on('data', (data) => chunks.push(Buffer.from(data)));
      wire.once('close', () => sockets.delete(wire));
    }
    socket.pipe(target).pipe(socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`,
    chunks,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}
function stores(pin?: ChannelPairing) {
  let relaySecret: string | undefined;
  let credential: string | undefined;
  const options: ClientOptions = {
    // The HTTPS variant uses the local fixture's self-signed certificate only.
    createWebSocket: (url) => new WebSocket(url, { rejectUnauthorized: false }),
    channelPairingStore: {
      load: async () => pin,
      save: async (_root, value) => {
        pin = value;
      },
    },
    relaySecretStore: {
      load: async () => relaySecret,
      save: async (_root, value) => {
        relaySecret = value;
      },
    },
    nativePairingStore: {
      load: async () => credential,
      save: async (_root, value) => {
        credential = value;
      },
    },
  };
  return { options };
}
function model() {
  return createHttpServer(async (req, res) => {
    if (req.url === '/v1/models') return void res.end('{"data":[{"id":"fake"}]}');
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (!request.stream) return void res.end(JSON.stringify({ choices: [{ message: { content: 'Relay' } }] }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'r', model: 'fake', choices: [{ index: 0, delta: { role: 'assistant', content: 'RELAY PRIVATE ANSWER' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'r', model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
}
it.skipIf(process.env.SWIFTNEST_E2E !== '1').each([false, true])(
  'real kernel and relay process (home TLS: %s): LAN preference, learned fallback, private chat and approval round trip',
  async (tls) => {
    const relay = await relayProcess();
    const tapped = await sniff(relay.url);
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-relay-e2e-'));
    const fake = model();
    const clients: SwiftnestClient[] = [];
    let kernel: Awaited<ReturnType<typeof startStableKernel>> | undefined;
    let stage = 'start kernel';
    try {
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
      const config = loadConfig(undefined, {
        SWIFTNEST_HOME: home,
        SWIFTNEST_PORT: '0',
        SWIFTNEST_DEVICES_PORT: '0',
        SWIFTNEST_DEVICES_MDNS: 'false',
        SWIFTNEST_PLUGINS: 'tool-ultra=false',
        SWIFTNEST_MODEL_ID: 'fake',
        SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
      });
      const env = tls ? await testTls(config, '127.0.0.1') : undefined;
      kernel = await startStableKernel(config, { readyTimeoutMs: 90000, env });
      // A fresh owner-supplied pairing link must be able to replace an old server pin.
      const saved = stores({ ...kernel.channelPairing, key: encodeBytes(new Uint8Array(32)) });
      const local = new SwiftnestClient(saved.options);
      clients.push(local);
      stage = 'pair over LAN';
      await local.connect(pairingUrl(kernel.url, kernel.token, kernel.channelPairing));
      expect((await saved.options.channelPairingStore!.load(kernel.url))!.key).toBe(kernel.channelPairing.key);
      stage = 'save relay';
      await local.setRelay({ address: tapped.url, secret });
      await expect.poll(async () => (await local.getRelay()).connected).toBe(true);
      expect(local.connectionPath).toBe('lan');
      const learned = await saved.options.channelPairingStore!.load(kernel.url);
      expect(learned!.addresses.relay).toEqual([tapped.url]);
      expect(JSON.stringify(learned)).not.toContain(secret);
      const nativeSecret = await saved.options.relaySecretStore!.load(kernel.url);
      expect(nativeSecret).toBe(secret);
      const remoteOptions = {
        ...saved.options,
        createWebSocket: (url: string) => {
          if (new URL(url).port === new URL(kernel!.url).port) return new WebSocket('ws://127.0.0.1:1/');
          return new WebSocket(url, { rejectUnauthorized: false });
        },
        fetch: async () => {
          throw new Error('No plain App HTTP');
        },
      };
      const remote = new SwiftnestClient(remoteOptions);
      clients.push(remote);
      stage = 'resume over relay';
      await remote.resume(kernel.url);
      expect(remote.connectionPath).toBe('relay');
      expect(await remote.health()).toMatchObject({ ok: true });
      const session = await remote.createSession();
      stage = 'chat over relay';
      const events = await remote.follow(session.sessionId, { signal: AbortSignal.timeout(20000) });
      const output: unknown[] = [];
      const consume = (async () => {
        for await (const event of events) {
          output.push(event);
          if (event.type === 'turn-end') break;
        }
      })();
      await remote.sendMessage(session.sessionId, 'RELAY PRIVATE CHAT 你好');
      await consume;
      events.close();
      expect(JSON.stringify(output)).toContain('RELAY PRIVATE ANSWER');
      stage = 'approval over relay';
      await deviceApproval(kernel, remote, home);
      await expect(remote.openLiveView('test')).rejects.toThrow();
      await expect(remote.listTransfers()).rejects.toMatchObject({ code: 'relay-lan-only' });
      const bytes = Buffer.concat(tapped.chunks);
      for (const plain of ['RELAY PRIVATE CHAT', 'RELAY PRIVATE ANSWER', 'RELAY PRIVATE FILE', '你好'])
        expect(bytes.includes(Buffer.from(plain))).toBe(false);
      expect(bytes.length).toBeGreaterThan(1000);
    } catch (error) {
      throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      for (const client of clients) client.close();
      await kernel?.stop();
      await tapped.close();
      await stop(relay.child);
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  120000,
);
async function deviceApproval(
  kernel: Awaited<ReturnType<typeof startStableKernel>>,
  client: SwiftnestClient,
  home: string,
) {
  const perch = await new Perch({ device: 'test' }).use(files, { roots: [home] });
  kernel.devices.nest.attach(memoryLink(perch));
  try {
    const task = await kernel.devices.nest.call(
      'test__files__write',
      { path: join(home, 'relay.txt'), content: 'RELAY PRIVATE FILE' },
      { id: 'relay-test', name: 'Relay' },
    );
    await expect
      .poll(async () => (await client.listDeviceApprovals()).some((entry) => entry.id === task.id))
      .toBe(true);
    await client.answerDeviceApproval(task.id, true);
    expect((await kernel.devices.nest.tasks.wait(task.id, 5000)).state).toBe('succeeded');
    expect(await readFile(join(home, 'relay.txt'), 'utf8')).toBe('RELAY PRIVATE FILE');
  } finally {
    await perch.close();
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.send('stop');
  await exited;
}
