import { message } from '@swiftnest/protocol';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeviceConnection } from './devices.js';
import { ChatSearch, type SearchSources, type SearchSession, type SearchEvent } from './chat-search/service.js';
import { searchHandler, SEARCH_PREFIX } from './chat-search/http.js';
import type { EmbeddingConfig } from './chat-search/embeddings.js';

export const name = 'swiftnest-chat-search';
export const inject = ['tools', 'webServer', 'connection', 'sessions', 'sessionPersistence'];
interface SearchContext extends SearchSources {
  connection: DeviceConnection;
  webServer: {
    register(route: {
      kind: 'prefix';
      path: string;
      handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
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
      execute(args: { query: string; limit?: number }): Promise<{ text: string }>;
    }): () => void;
  };
  on(event: 'session/event', listener: (session: SearchSession, event: SearchEvent) => void): () => void;
  on(event: 'session/disposed', listener: (session: SearchSession) => void): () => void;
  effect(fn: () => () => void | Promise<void>, label?: string): void;
}
export function apply(ctx: SearchContext, config: EmbeddingConfig & { settings?: unknown }) {
  const service = new ChatSearch(ctx, config);
  ctx.effect(() => () => service.close(), 'swiftnest-chat-search: storage');
  ctx.on('session/event', (session, event) => service.event(session, event));
  ctx.on('session/disposed', (session) => service.dispose(session));
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: SEARCH_PREFIX,
        handler: searchHandler(ctx.connection, service),
      }),
    'swiftnest-chat-search: api',
  );
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'search_chats',
        description: message('chatSearchTool'),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
          required: ['query'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        execute: async (args) => {
          const results = await service.search(args.query, args.limit);
          return { text: JSON.stringify(results.map((row) => ({ ...row, date: new Date(row.time).toISOString() }))) };
        },
      }),
    'swiftnest-chat-search: tool',
  );
  // Indexing failures stay isolated from the session append feed and chat startup.
  void service.start().catch(() => {});
}
