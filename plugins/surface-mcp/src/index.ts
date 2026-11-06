/**
 * @swiftnest/surface-mcp — exposes every connected device's tools to any MCP client (Claude Desktop, Cursor, DSH…).
 *
 * - Transports: stdio, and Streamable HTTP with sessions (so clients get tools/list_changed when devices come and go).
 * - Calls that finish within `waitSeconds` return their result; calls that need approval or run long return a task id,
 *   and the agent follows up with swiftnest__task_wait / task_status / task_cancel (design §4.2).
 * - There is deliberately NO approve tool: an agent must never be able to approve its own request.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { definePlugin, SwiftnestFailure, text, type Nest, type Text } from '@swiftnest/core';
import {
  localize,
  localizedReason,
  localizedError,
  defaultLanguage,
  message,
  render,
  stateText,
  type Language,
  type ClientRef,
  type TaskSnapshot,
} from '@swiftnest/protocol';

export interface McpSurfaceOptions {
  /** Seconds a call may block before returning a task id instead (default 25). */
  waitSeconds?: number;
  /** Language of tool descriptions shown to agents (default "zh"). */
  lang?: 'en' | 'zh';
  serverName?: string;
  /** Optional bearer credential, checked on every HTTP request including SSE. */
  bearerToken?: string;
}

const META = {
  devices: 'swiftnest__devices',
  status: 'swiftnest__task_status',
  wait: 'swiftnest__task_wait',
  cancel: 'swiftnest__task_cancel',
} as const;

/** The tools Swiftnest adds next to the devices' own, described in `lang`. */
function metaTools(lang: Language) {
  const taskId = { task_id: { type: 'string', description: message('mcpTaskIdArg', lang) } };
  return [
    {
      name: META.devices,
      description: message('mcpDevicesTool', lang),
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: META.status,
      description: message('mcpStatusTool', lang),
      inputSchema: { type: 'object', properties: taskId, required: ['task_id'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: META.wait,
      description: message('mcpWaitTool', lang),
      inputSchema: {
        type: 'object',
        properties: {
          ...taskId,
          seconds: { type: 'number', description: message('mcpWaitSecondsArg', lang) },
        },
        required: ['task_id'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: META.cancel,
      description: message('mcpCancelTool', lang),
      inputSchema: { type: 'object', properties: taskId, required: ['task_id'] },
    },
  ];
}

function textResult(text: string, isError = false, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    isError,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** Turn a task snapshot into what the agent sees. */
export function describeTask(s: TaskSnapshot, lang: Language = defaultLanguage()) {
  const say = (value: Text) => render(value, lang);
  const structured = { task_id: s.id, state: s.state, device: s.device, tool: `${s.capability}.${s.tool}` } as Record<
    string,
    unknown
  >;
  switch (s.state) {
    case 'succeeded': {
      const r = s.result!;
      if (r.data !== undefined) structured.data = r.data;
      return textResult(
        r.untrusted ? `${say(text('untrustedContentNote'))}\n${r.text}` : r.text || say(text('noOutput')),
        false,
        structured,
      );
    }
    case 'pending_approval': {
      const why = s.reason ? localizedReason(s, lang) : say(text('mcpByPolicy'));
      return textResult(
        say(text('mcpWaitingForApproval', why, s.id)) + say(text('mcpContinueOrWait', META.wait)),
        false,
        structured,
      );
    }
    case 'queued':
    case 'running':
      return textResult(say(text('mcpStillRunning', stateText(s.state), s.id, META.wait)), false, structured);
    case 'cancelled':
      // The agent asked for this, so it is an outcome, not a failure. Reporting it
      // as an error (with a "check the connection and retry" hint) made callers
      // retry a cancel that had already worked. A call that had already started
      // is stopped part-way, so it says so instead of claiming nothing ran.
      return textResult(
        say(s.started ? text('mcpCancelledRunning', s.id) : text('mcpCancelled', s.id)),
        false,
        structured,
      );
    default: {
      const e = s.error ? localizedError(s.error, lang) : undefined;
      return textResult(e ? failureLine(e, lang) : s.state, true, { ...structured, error: e });
    }
  }
}

/** "CODE: message", plus how to fix it when the failure says. */
function failureLine(e: { code: string; message: string; hint?: string }, lang: Language): string {
  return `${e.code}: ${e.message}${e.hint ? render(text('mcpHowToFix', e.hint), lang) : ''}`;
}

/** Build one MCP server instance (one per stdio connection or HTTP session) bound to a Nest. */
export function createMcpServer(nest: Nest, opts: McpSurfaceOptions = {}): Server {
  const waitMs = (opts.waitSeconds ?? 25) * 1000;
  const lang = opts.lang ?? (process.env.SWIFTNEST_LANG === 'en' ? 'en' : 'zh');
  const language = lang === 'en' ? 'en' : 'zh-CN';
  const server = new Server(
    { name: opts.serverName ?? 'swiftnest', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );

  const client = (): ClientRef => {
    const info = server.getClientVersion();
    return { id: `mcp:${info?.name ?? 'unknown'}`, name: info ? `${info.name} ${info.version}` : undefined };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...nest.tools().map((t) => ({
        name: t.name,
        title: t.tool.title ? `${t.device}: ${localize(t.tool.title, lang)}` : undefined,
        description: `[device: ${t.device}] ${localize(t.tool.description, lang)}`,
        inputSchema: { type: 'object' as const, ...t.tool.inputSchema },
        annotations: { readOnlyHint: t.tool.risk === 'read', destructiveHint: t.tool.risk === 'sensitive' },
      })),
      ...metaTools(language),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === META.devices) {
        const devices = nest.devices();
        return textResult(
          devices.length ? JSON.stringify(devices, null, 2) : message('mcpNoDevices', language),
          false,
          { devices },
        );
      }
      if (name === META.status || name === META.wait || name === META.cancel) {
        const id = String(args.task_id ?? '');
        if (name === META.cancel) return describeTask(await nest.tasks.cancel(id), language);
        if (name === META.status) {
          const s = nest.tasks.get(id);
          if (!s) throw new SwiftnestFailure('UNKNOWN_TASK', text('noTask', id), text('hintUseOriginalTaskId'));
          return describeTask(s, language);
        }
        const secs = Math.min(Math.max(Number(args.seconds ?? 25), 1), 300);
        return describeTask(await nest.tasks.wait(id, secs * 1000), language);
      }
      const task = await nest.call(name, args, client());
      // Return at once if the call needs a person; otherwise wait up to waitSeconds for the result.
      return describeTask(await nest.tasks.wait(task.id, waitMs, { untilPending: true }), language);
    } catch (e) {
      const err = { ...SwiftnestFailure.from(e), ...localizedError(e, language) };
      return textResult(failureLine(err, language), true, { error: err });
    }
  });

  return server;
}

/** Streamable HTTP endpoint at http://host:port/mcp with per-session MCP servers. */
export async function serveMcpHttp(nest: Nest, opts: McpSurfaceOptions & { host?: string; port?: number } = {}) {
  const host = opts.host ?? '127.0.0.1';
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  let port = opts.port ?? 7710;

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let s = '';
      req.on('data', (c: Buffer) => (s += c.toString('utf8')));
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : undefined);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (opts.bearerToken) {
      const expected = Buffer.from(`Bearer ${opts.bearerToken}`);
      const given = Buffer.from(req.headers.authorization ?? '');
      if (given.length !== expected.length || !timingSafeEqual(expected, given)) {
        res.writeHead(401).end();
        return;
      }
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Swiftnest MCP endpoint is at /mcp\n');
      return;
    }
    const sid = req.headers['mcp-session-id'];
    const existing = typeof sid === 'string' ? sessions.get(sid) : undefined;
    try {
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (existing) return void (await existing.transport.handleRequest(req, res, body));
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'No valid session; send initialize first.' },
              id: null,
            }),
          );
          return;
        }
        const server = createMcpServer(nest, opts);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `${host}:${port}`],
          onsessioninitialized: (id) => void sessions.set(id, { transport, server }),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if ((req.method === 'GET' || req.method === 'DELETE') && existing)
        return void (await existing.transport.handleRequest(req, res));
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Unknown or missing MCP session.\n');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e));
    }
  };

  const http: HttpServer = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => resolve());
  });
  const addr = http.address();
  if (addr && typeof addr === 'object') port = addr.port;

  const offTools = nest.onToolsChanged(() => {
    for (const { server } of sessions.values()) void server.sendToolListChanged().catch(() => {});
  });

  return {
    url: `http://${host}:${port}/mcp`,
    port,
    async close() {
      offTools();
      for (const { transport } of sessions.values()) await transport.close().catch(() => {});
      sessions.clear();
      const closed = new Promise<void>((r) => http.close(() => r()));
      http.closeAllConnections();
      await closed;
    },
  };
}

/** stdio transport: the MCP client launches this process (e.g. Claude Desktop's "command"). */
export async function serveMcpStdio(nest: Nest, opts: McpSurfaceOptions = {}) {
  const server = createMcpServer(nest, opts);
  const off = nest.onToolsChanged(() => void server.sendToolListChanged().catch(() => {}));
  await server.connect(new StdioServerTransport());
  return {
    async close() {
      off();
      await server.close();
    },
  };
}

export default definePlugin({
  name: '@swiftnest/surface-mcp',
  kind: 'surface',
  apiVersion: 1,
  runsOn: 'nest',
  async setup(ctx) {
    if (ctx.role !== 'nest') return;
    const cfg = ctx.config as McpSurfaceOptions & { stdio?: boolean; http?: { host?: string; port?: number } | false };
    const closers: (() => Promise<void>)[] = [];
    if (cfg.http !== false) {
      const h = await serveMcpHttp(ctx.nest, { ...cfg, ...(cfg.http || {}) });
      ctx.logger.info(text('mcpEndpointLog', h.url));
      closers.push(h.close);
    }
    if (cfg.stdio) closers.push((await serveMcpStdio(ctx.nest, cfg)).close);
    return async () => {
      for (const c of closers) await c();
    };
  },
});
