import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ApiWebSocket } from '@swiftnest/api';
import { Perch, memoryLink } from '@swiftnest/core';
import files from '@swiftnest/cap-files';
import { connect, type SwiftnestClient } from '@swiftnest/api';
import { loadConfig, startKernel, pairingUrl, type RunningKernel } from '../../../server/src/index.js';

const { WebSocket } = createRequire(new URL('../../../server/package.json', import.meta.url))('ws') as {
  WebSocket: new (url: string, options?: { headers: Readonly<Record<string, string>> }) => ApiWebSocket;
};

async function modelResponse(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/v1/models') return void res.end('{"data":[{"id":"fake"}]}');
  if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  let body = '';
  for await (const chunk of req) body += String(chunk);
  const request = JSON.parse(body);
  if (!request.stream)
    return void res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Approval test' } }] }));
  const needsTool =
    request.messages.some(
      (message: { role: string; content: unknown }) =>
        message.role === 'user' && message.content === 'request-approval',
    ) && !request.messages.some((message: { role: string }) => message.role === 'tool');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish_reason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'fake', model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: 'assistant', content: '' });
  if (needsTool) {
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call-inbox',
          type: 'function',
          function: { name: 'approval_test', arguments: '{"path":"/shared/report.txt"}' },
        },
      ],
    });
    chunk({}, 'tool_calls');
  } else {
    chunk({ content: 'Done.' });
    chunk({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
}
async function approvalPlugin(home: string) {
  const plugin = join(home, 'approval-fixture.mjs');
  await writeFile(
    plugin,
    `export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({ name: 'approval_test', description: 'Harmless approval fixture',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'approved once' });
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'approval_test'
    ? Promise.resolve({ kind: 'ask', reason: 'Read the shared report?', displayReason: { en: 'Read the shared report?', 'zh-CN': '允许读取共享报告吗？' } }) : next(), true);
}`,
  );
  const profile = join(home, 'dsh/profiles/swiftnest');
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'user.patch.yml'),
    JSON.stringify([{ insert: [{ id: 'approval-fixture', name: plugin }] }]),
  );
}
export class ApprovalHarness {
  readonly logs: string[] = [];
  readonly model = createServer(modelResponse);
  kernel?: RunningKernel;
  client?: SwiftnestClient;
  perch?: Perch;
  home = '';
  async start() {
    this.home = await mkdtemp(join(tmpdir(), 'approval-real-'));
    await approvalPlugin(this.home);
    await new Promise<void>((resolve) => this.model.listen(0, '127.0.0.1', resolve));
    const config = loadConfig(undefined, {
      SWIFTNEST_HOME: this.home,
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_PORT: '0',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_PLUGINS: 'tool-ultra=false',
      SWIFTNEST_MODEL_ID: 'fake',
      SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(this.model.address() as { port: number }).port}/v1`,
      SWIFTNEST_APP_DIST: fileURLToPath(new URL('../../dist/', import.meta.url)),
    });
    this.kernel = await startKernel(config, {
      readyTimeoutMs: 45000,
      onLine: (line) => this.logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')),
    });
    this.client = await connect(pairingUrl(this.kernel.url, this.kernel.token, this.kernel.channelPairing), {
      createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
    });
    this.perch = await new Perch({ device: 'computer' }).use(files, { roots: [this.home] });
    this.kernel.devices.nest.attach(memoryLink(this.perch));
  }
  writeRequest() {
    return this.kernel!.devices.nest.call(
      'computer__files__write',
      { path: join(this.home, 'approved.txt'), content: 'Approved from inbox' },
      { id: 'test-client', name: 'Test computer' },
    );
  }
  async close() {
    this.client?.close();
    await this.kernel?.stop();
    await this.perch?.close();
    await new Promise<void>((resolve) => {
      this.model.close(() => resolve());
      this.model.closeAllConnections();
    });
    if (this.home) await rm(this.home, { recursive: true, force: true });
  }
}
