/** Real pinned kernel + deterministic model + encrypted LAN Perch; no external credentials. */
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { Perch } from '@swiftnest/core';
import { runLanPerch } from '@swiftnest/link-lan';
import files from '@swiftnest/cap-files';
import { connect, type SwiftnestClient } from '@swiftnest/api';
import { startKernel, type RunningKernel } from '../src/kernel.js';
import { loadConfig } from '../src/config.js';
import { pairingUrl } from '../src/pairing.js';

it.skipIf(process.env.SWIFTNEST_E2E !== '1')(
  'DSH discovers live devices → reads → writes after App approval → audits → retains offline tools → revokes',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-device-e2e-'));
    const shared = join(home, 'shared');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(shared);
    await writeFile(join(shared, 'read.txt'), 'read from the real Perch');
    const logs: string[] = [];
    const requests: any[] = [];
    const rounds = new Map<string, number>();
    let kernel: RunningKernel | undefined, client: SwiftnestClient | undefined;
    let perch: Perch | undefined, run: ReturnType<typeof runLanPerch> | undefined;
    const model = createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.end('{"data":[{"id":"fake"}]}');
        return;
      }
      let raw = '';
      for await (const part of req) raw += String(part);
      const request = JSON.parse(raw);
      requests.push(request);
      const latestUser = [...request.messages]
        .reverse()
        .find(
          (m: any) =>
            m.role === 'user' &&
            [
              'read-device',
              'write-device',
              'tools-before',
              'tools-after',
              'tools-fresh',
              'tools-offline',
              'tools-revoked',
              'origin-native',
              'origin-web',
            ].includes(m.content),
        )?.content;
      const prompt = typeof latestUser === 'string' ? latestUser : JSON.stringify(latestUser);
      const kind = [
        'read-device',
        'write-device',
        'tools-before',
        'tools-after',
        'tools-fresh',
        'tools-offline',
        'tools-revoked',
        'origin-native',
        'origin-web',
      ].find((p) => prompt === p);
      const round = rounds.get(kind ?? '') ?? 0;
      let tool: { name: string; arguments: string } | undefined;
      const text = 'Done.';
      if (kind) {
        rounds.set(kind, round + 1);
        if ((kind === 'read-device' || kind === 'tools-offline') && round === 0)
          tool = { name: 'device__node__files_read', arguments: JSON.stringify({ path: join(shared, 'read.txt') }) };
        if ((kind === 'origin-native' || kind === 'origin-web') && round === 0)
          tool = { name: 'test_devices_service', arguments: '{}' };
        if (kind === 'write-device' && round === 0)
          tool = {
            name: 'device__node__files_write',
            arguments: JSON.stringify({ path: join(shared, 'write.txt'), content: 'owner approved' }),
          };
      }
      if (!request.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'title',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      chunk({ role: 'assistant', content: '' });
      if (tool) {
        chunk({ tool_calls: [{ index: 0, id: `call-${kind}-${round}`, type: 'function', function: tool }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ content: text });
        chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
    try {
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      // A consumer plugin verifies the public service in the real Cordis/DSH process.
      const consumer = join(home, 'device-consumer.mjs');
      await writeFile(
        consumer,
        `
      export const inject = ['tools', 'swiftnestDevices'];
      export function apply(ctx) {
        const events = [];
        ctx.on('swiftnest/devices-changed', event => events.push(event));
        ctx.tools.register({ name: 'test_devices_service', description: 'Test device directory',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'object', properties: { current: {}, devices: { type: 'array', items: {} }, events: { type: 'array', items: {} } } },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (_args, exec) => ({ current: ctx.swiftnestDevices.currentFor(exec.agent.id) ?? null, devices: ctx.swiftnestDevices.list(), events }) });
      }
    `,
      );
      await mkdir(join(home, 'dsh/profiles/swiftnest'), { recursive: true });
      await writeFile(
        join(home, 'dsh/profiles/swiftnest/user.patch.yml'),
        JSON.stringify([{ insert: [{ id: 'test-device-consumer', name: consumer }] }]),
      );
      kernel = await startKernel(
        loadConfig(undefined, {
          SWIFTNEST_LANG: 'en',
          SWIFTNEST_HOME: home,
          SWIFTNEST_PORT: '0',
          SWIFTNEST_DEVICES_PORT: '0',
          SWIFTNEST_DEVICES_MDNS: 'false',
          SWIFTNEST_MODEL_ID: 'fake',
          SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
        }),
        { onLine: (line) => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')) },
      );
      const route = new URL('swiftnest/api/devices', kernel.url);
      expect((await fetch(route)).status).toBe(401);
      expect(
        (await fetch(route, { headers: { authorization: `Bearer ${kernel.devices.env.SWIFTNEST_DEVICES_MCP_TOKEN}` } }))
          .status,
      ).toBe(401);
      const login = await fetch(pairingUrl(kernel.url, kernel.token), { redirect: 'manual' });
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect((await fetch(route, { headers: { cookie, origin: 'https://untrusted.test' } })).status).toBe(403);
      expect((await fetch(route, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
      client = await connect(pairingUrl(kernel.url, kernel.token), {
        createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
      });
      const session = await client.createSession();
      async function turn(prompt: string, sessionId = session.sessionId, sender = client!) {
        const sub = await sender.follow(sessionId, { signal: AbortSignal.timeout(20_000) });
        const events: any[] = [];
        let started = false;
        const done = (async () => {
          for await (const e of sub) {
            if (e.type === 'user-message' && e.text === prompt) started = true;
            if (!started) continue;
            events.push(e);
            if (e.type === 'approval-request') await sender.answerApproval(e.requestId, 'allowed-once');
            if (e.type === 'turn-end') break;
          }
        })();
        await sender.sendMessage(sessionId, prompt);
        await done;
        sub.close();
        expect(events.filter((e) => e.type === 'error')).toEqual([]);
        return events;
      }
      await turn('tools-before');
      const pairing = await client.createDevicePairing();
      perch = await new Perch({ device: 'node' }).use(files, { roots: [shared] });
      run = runLanPerch(perch, {
        url: pairing.url,
        reconnect: false,
        pairing: { code: pairing.code, confirm: async (fp) => fp === pairing.fingerprint },
      });
      await expect.poll(async () => (await client!.listDevicePairings()).length).toBe(1);
      await client.confirmDevicePairing((await client.listDevicePairings())[0]!.id, true);
      await expect.poll(async () => (await client!.listDevices())[0]?.online).toBe(true);
      await turn('tools-after');
      const toolNames = (kind: string) =>
        requests
          .find((r) => r.messages.some((m: any) => m.role === 'user' && m.content === kind))
          ?.tools?.map((t: any) => t.function.name) ?? [];
      expect(toolNames('tools-before')).not.toContain('device__node__files_read');
      expect(toolNames('tools-after')).toContain('device__node__files_read');
      expect(
        toolNames('tools-after').some((n: string) => n.startsWith('mcp__devices__') || n.startsWith('device__task_')),
      ).toBe(false);
      expect(
        toolNames('tools-after').some((n: string) => /approv|pair|revoke/.test(n) && n.startsWith('device__')),
      ).toBe(false);
      const nativeClient = await connect(pairingUrl(kernel.url, kernel.token), {
        deviceSlug: 'node',
        createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
      });
      try {
        const nativeEvents = await turn('origin-native', session.sessionId, nativeClient);
        const nativeResult = nativeEvents.find((e) => e.type === 'tool-result');
        expect(nativeResult?.isError).toBe(false);
        expect(JSON.parse(nativeResult!.text)).toMatchObject({
          current: 'node',
          devices: [{ slug: 'node', kind: 'desktop', online: true }],
          events: expect.arrayContaining([{ slugs: ['node'] }]),
        });
        const webEvents = await turn('origin-web');
        expect(JSON.parse(webEvents.find((e) => e.type === 'tool-result')!.text).current).toBeNull();
      } finally {
        nativeClient.close();
      }
      await turn('read-device');
      expect(
        requests.some((r) =>
          r.messages.some(
            (m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('read from the real Perch'),
          ),
        ),
      ).toBe(true);
      const writing = turn('write-device');
      await expect.poll(async () => (await client!.listDeviceApprovals()).length).toBe(1);
      const approval = (await client.listDeviceApprovals())[0]!;
      expect(approval).toMatchObject({
        device: 'node',
        risk: 'write',
        args: { path: join(shared, 'write.txt'), content: 'owner approved' },
      });
      await expect(readFile(join(shared, 'write.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await client.answerDeviceApproval(approval.id, true);
      await writing;
      expect(rounds.get('write-device')).toBe(2);
      expect(await readFile(join(shared, 'write.txt'), 'utf8')).toBe('owner approved');
      const audit = await client.deviceAudit();
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tool: 'read', state: 'succeeded' }),
          expect.objectContaining({ tool: 'write', state: 'pending_approval' }),
          expect.objectContaining({ tool: 'write', state: 'succeeded', reason: expect.stringContaining('App owner') }),
        ]),
      );
      const fresh = await client.createSession();
      await turn('tools-fresh', fresh.sessionId);
      expect(toolNames('tools-fresh')).toContain('device__node__files_read');
      run.stop();
      await run.finished;
      await expect.poll(async () => (await client!.listDevices())[0]?.online).toBe(false);
      const offlineEvents = await turn('tools-offline');
      expect(toolNames('tools-offline')).toContain('device__node__files_read');
      expect(offlineEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-result',
            isError: true,
            text: expect.stringMatching(/device node is offline \(last seen \d{4}-.*Z\)/),
          }),
        ]),
      );
      await client.revokeDevice('node');
      await expect.poll(async () => (await client!.listDevices()).length).toBe(0);
      await turn('tools-revoked');
      expect(toolNames('tools-revoked')).not.toContain('device__node__files_read');
      // Neither parent nor kernel persistence may contain the process credentials.
      for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const data = await readFile(join(entry.parentPath, entry.name));
        expect(data.includes(Buffer.from(kernel.devices.env.SWIFTNEST_DEVICES_MCP_TOKEN)), entry.name).toBe(false);
        expect(data.includes(Buffer.from(kernel.devices.env.SWIFTNEST_DEVICES_ADMIN_TOKEN)), entry.name).toBe(false);
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.stack : error}\n${logs.slice(-60).join('\n')}\nModel tools: ${JSON.stringify(requests.map((r) => ({ last: r.messages.at(-1), tools: r.tools?.map((t: any) => t.function.name) })))}`,
      );
    } finally {
      run?.stop();
      await run?.finished;
      await perch?.close();
      client?.close();
      await kernel?.stop();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  90_000,
);
