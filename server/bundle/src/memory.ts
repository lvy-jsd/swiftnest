/** Single-assistant central memory. No App or model owns a separate copy. */
import { message, text } from '@swiftnest/protocol';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeviceConnection } from './devices.js';
import { ServerFailure } from './memory/failure.js';
import { MemoryStore } from './memory/store.js';
import { AUTO_DELAY_MS, registerAutomaticMemory, type AutoContext } from './memory/auto.js';
import { memoryHandler } from './memory/http.js';

export const name = 'swiftnest-memory';
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection', 'llm', 'sessions', 'sessionPersistence'];

interface MemoryContext extends AutoContext {
  connection: DeviceConnection;
  webServer: {
    register(route: {
      kind: 'prefix';
      path: string;
      handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }): () => void;
  };
  systemPrompt: {
    section(section: {
      name: string;
      order: number;
      interpolate: false;
      text(context: { agent?: { id: string } }): string;
    }): () => void;
  };
  tools: {
    register(tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: { text: string }): { type: 'text'; text: string }[];
      };
      execute(args: Record<string, string>, exec: { agent?: { id: string } }): Promise<{ text: string }>;
    }): () => void;
  };
  effect(fn: () => () => void, label?: string): void;
}

interface MemoryConfig {
  home: string;
  enabled?: boolean;
  auto?: boolean;
  devicesAdminUrl?: string;
  devicesAdminToken?: string;
}

export function apply(ctx: MemoryContext, config: MemoryConfig, reviewDelay = AUTO_DELAY_MS) {
  const changed = memoryChanged(config);
  const store = config.enabled === false ? undefined : new MemoryStore(config.home, undefined, changed);
  const automatic = store ? registerAutomaticMemory(ctx, store, config.auto, reviewDelay) : undefined;
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/swiftnest/api/memory',
        handler: memoryHandler(ctx.connection, store, config.auto, () => automatic?.settingsChanged()),
      }),
    'swiftnest-memory: api',
  );
  if (!store) return;
  // Pinned DSH rc.5 removes live sessions via SessionStore.detachEntered;
  // its paired session/disposed event also drives api-session/removed.
  ctx.on('session/disposed', (session) => store.deleteSnapshot(session.id));
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'swiftnest:memory',
        order: 645,
        interpolate: false,
        text: (context) => (context.agent ? store.snapshot(context.agent.id) : ''),
      }),
    'swiftnest-memory: prompt',
  );
  registerTools(ctx, store);
}

function memoryChanged(config: MemoryConfig): () => Promise<void> {
  const { devicesAdminUrl, devicesAdminToken } = config;
  if (!devicesAdminUrl || !devicesAdminToken) return async () => {};
  const endpoint = new URL(devicesAdminUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password)
    throw new ServerFailure(text('deviceAdminMustUseLoopback'));
  return async () => {
    const response = await fetch(new URL('/swiftnest/control/devices/memory-changed', endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${devicesAdminToken}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok) throw new ServerFailure(text('deviceApiReturnedHttp', response.status));
  };
}

function registerTools(ctx: MemoryContext, store: MemoryStore) {
  const tools = [
    {
      name: 'remember',
      description: 'memoryRememberTool',
      properties: { text: { type: 'string' }, topic: { type: 'string' } },
      required: ['text'],
    },
    {
      name: 'forget',
      description: 'memoryForgetTool',
      properties: { text: { type: 'string' }, id: { type: 'string' } },
    },
    {
      name: 'recall',
      description: 'memoryRecallTool',
      properties: { query: { type: 'string' }, topic: { type: 'string' } },
    },
  ] as const;
  for (const tool of tools) {
    ctx.effect(
      () =>
        ctx.tools.register({
          name: tool.name,
          description: message(tool.description),
          parameters: {
            type: 'object',
            properties: tool.properties,
            ...('required' in tool ? { required: tool.required } : {}),
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          execute: (args, exec) => executeTool(store, tool.name, args, exec.agent?.id),
        }),
      `swiftnest-memory: ${tool.name}`,
    );
  }
}

async function executeTool(store: MemoryStore, name: string, args: Record<string, string>, sessionId?: string) {
  try {
    if (name === 'recall') return { text: JSON.stringify(await store.recall(args)) };
    if (name === 'forget') {
      await store.forget(args.id ?? args.text ?? '');
      return { text: message('memoryForgotten') };
    }
    const result = await store.remember(args.text, args.topic, sessionId ? `session:${sessionId}` : 'assistant');
    return { text: message(result.saved ? 'memorySaved' : 'memoryAlreadySaved') };
  } catch (error) {
    // The pinned DSH tool runtime retains Error.message only. Keep the catalog key and
    // arguments in the actual isError result without exposing the rejected entry.
    if (error instanceof ServerFailure) error.message = JSON.stringify({ code: error.code, text: error.text });
    throw error;
  }
}
