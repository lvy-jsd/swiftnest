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

it.skipIf(process.env.SWIFTNEST_E2E !== '1')('DSH discovers live devices → reads → writes after App approval → audits → removes tools', async () => {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-device-e2e-'));
  const shared = join(home, 'shared');
  const { mkdir } = await import('node:fs/promises'); await mkdir(shared);
  await writeFile(join(shared, 'read.txt'), 'read from the real Perch');
  const logs: string[] = [];
  const requests: any[] = [];
  const rounds = new Map<string, number>();
  let kernel: RunningKernel | undefined, client: SwiftnestClient | undefined;
  let perch: Perch | undefined, run: ReturnType<typeof runLanPerch> | undefined;
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.end('{"data":[{"id":"fake"}]}'); return; }
    let raw = ''; for await (const part of req) raw += String(part);
    const request = JSON.parse(raw); requests.push(request);
    const latestUser = [...request.messages].reverse().find((m: any) => m.role === 'user' && ['read-device', 'write-device', 'tools-before', 'tools-after', 'tools-fresh', 'tools-offline'].includes(m.content))?.content;
    const prompt = typeof latestUser === 'string' ? latestUser : JSON.stringify(latestUser);
    const kind = ['read-device', 'write-device', 'tools-before', 'tools-after', 'tools-fresh', 'tools-offline'].find(p => prompt === p);
    const round = rounds.get(kind ?? '') ?? 0;
    let tool: { name: string; arguments: string } | undefined;
    let text = 'Done.';
    if (kind) {
      rounds.set(kind, round + 1);
      if (kind === 'read-device' && round === 0) tool = { name: 'mcp__devices__node__files__read', arguments: JSON.stringify({ path: join(shared, 'read.txt') }) };
      if (kind === 'write-device' && round === 0) tool = { name: 'mcp__devices__node__files__write', arguments: JSON.stringify({ path: join(shared, 'write.txt'), content: 'owner approved' }) };
      if (kind === 'write-device' && round === 1) {
        const task = /Task id: ([a-f0-9-]+)/i.exec(JSON.stringify(request.messages));
        if (task) tool = { name: 'mcp__devices__swiftnest__task_wait', arguments: JSON.stringify({ task_id: task[1], seconds: 10 }) };
        else text = 'Missing pending task id';
      }
    }
    if (!request.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'title', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    if (tool) { chunk({ tool_calls: [{ index: 0, id: `call-${kind}-${round}`, type: 'function', function: tool }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content: text }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    kernel = await startKernel(loadConfig(undefined, { SWIFTNEST_HOME: home, SWIFTNEST_PORT: '0', SWIFTNEST_DEVICES_PORT: '0', SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_MODEL_ID: 'fake', SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` }), { onLine: line => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')) });
    const route = new URL('swiftnest/api/devices', kernel.url);
    expect((await fetch(route)).status).toBe(401);
    expect((await fetch(route, { headers: { authorization: `Bearer ${kernel.devices.env.SWIFTNEST_DEVICES_MCP_TOKEN}` } })).status).toBe(401);
    const login = await fetch(pairingUrl(kernel.url, kernel.token), { redirect: 'manual' });
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect((await fetch(route, { headers: { cookie, origin: 'https://untrusted.test' } })).status).toBe(403);
    expect((await fetch(route, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    client = await connect(pairingUrl(kernel.url, kernel.token), { createWebSocket: (url, { headers }) => new WebSocket(url, { headers }) });
    const session = await client.createSession();
    async function turn(prompt: string, sessionId = session.sessionId) {
      const sub = await client!.follow(sessionId, { signal: AbortSignal.timeout(20_000) });
      const events: any[] = [];
      let started = false;
      const done = (async () => { for await (const e of sub) { if (e.type === 'user-message' && e.text === prompt) started = true; if (!started) continue; events.push(e); if (e.type === 'approval-request') await client!.answerApproval(e.requestId, 'allowed-once'); if (e.type === 'turn-end') break; } })();
      await client!.sendMessage(sessionId, prompt);
      await done; sub.close();
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      return events;
    }
    await turn('tools-before');
    const pairing = await client.createDevicePairing();
    perch = await new Perch({ device: 'node' }).use(files, { roots: [shared] });
    run = runLanPerch(perch, { url: pairing.url, reconnect: false, pairing: { code: pairing.code, confirm: async fp => fp === pairing.fingerprint } });
    await expect.poll(async () => (await client!.listDevicePairings()).length).toBe(1);
    await client.confirmDevicePairing((await client.listDevicePairings())[0]!.id, true);
    await expect.poll(async () => (await client!.listDevices())[0]?.online).toBe(true);
    await turn('tools-after');
    const toolNames = (kind: string) => requests.find(r => r.messages.some((m: any) => m.role === 'user' && m.content === kind))?.tools?.map((t: any) => t.function.name) ?? [];
    expect(toolNames('tools-before')).not.toContain('mcp__devices__node__files__read');
    expect(toolNames('tools-after')).toContain('mcp__devices__node__files__read');
    expect(toolNames('tools-after').some((n: string) => /approv|pair|revoke/.test(n) && n.startsWith('mcp__devices__'))).toBe(false);
    await turn('read-device');
    expect(requests.some(r => r.messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('read from the real Perch')))).toBe(true);
    const writing = turn('write-device');
    await expect.poll(async () => (await client!.listDeviceApprovals()).length).toBe(1);
    const approval = (await client.listDeviceApprovals())[0]!;
    expect(approval).toMatchObject({ device: 'node', risk: 'write', args: { path: join(shared, 'write.txt'), content: 'owner approved' } });
    await expect(readFile(join(shared, 'write.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await client.answerDeviceApproval(approval.id, true);
    await writing;
    expect(rounds.get('write-device')).toBe(3);
    expect(await readFile(join(shared, 'write.txt'), 'utf8')).toBe('owner approved');
    const audit = await client.deviceAudit();
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'read', state: 'succeeded' }),
      expect.objectContaining({ tool: 'write', state: 'pending_approval' }),
      expect.objectContaining({ tool: 'write', state: 'succeeded', reason: expect.stringContaining('App owner') }),
    ]));
    const fresh = await client.createSession();
    await turn('tools-fresh', fresh.sessionId);
    expect(toolNames('tools-fresh')).toContain('mcp__devices__node__files__read');
    await client.revokeDevice('node');
    await expect.poll(async () => (await client!.listDevices()).length).toBe(0);
    await turn('tools-offline');
    expect(toolNames('tools-offline')).not.toContain('mcp__devices__node__files__read');
    // Neither parent nor kernel persistence may contain the process credentials.
    for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const data = await readFile(join(entry.parentPath, entry.name));
      expect(data.includes(Buffer.from(kernel.devices.env.SWIFTNEST_DEVICES_MCP_TOKEN)), entry.name).toBe(false);
      expect(data.includes(Buffer.from(kernel.devices.env.SWIFTNEST_DEVICES_ADMIN_TOKEN)), entry.name).toBe(false);
    }
  } catch (error) { throw new Error(`${error instanceof Error ? error.stack : error}\n${logs.slice(-60).join('\n')}\nModel tools: ${JSON.stringify(requests.map(r => ({ last: r.messages.at(-1), tools: r.tools?.map((t: any) => t.function.name) })))}`); }
  finally { run?.stop(); await run?.finished; await perch?.close(); client?.close(); await kernel?.stop(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
}, 90_000);
