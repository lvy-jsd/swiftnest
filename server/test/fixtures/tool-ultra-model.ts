import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

interface ModelRequest {
  stream?: boolean;
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Each prompt selects a finite script, so no real model can choose host commands. */
export function scriptedModel(shared: string) {
  const steps: Record<string, ToolCall[]> = {
    calculate: [
      { name: 'tools_load', arguments: { targets: ['math_eval'] } },
      { name: 'math_eval', arguments: { expression: '2 inch to cm' } },
    ],
    'load-device': [
      { name: 'tools_ls', arguments: { path: '/device' } },
      { name: 'tools_load', arguments: { targets: ['device:all'] } },
      { name: 'device__node__files_read', arguments: { path: join(shared, 'hello.txt') } },
    ],
  };
  for (const prompt of ['risk-deny', 'risk-allow', 'risk-browser-deny', 'risk-browser-allow']) {
    steps[prompt] = [{ name: 'tools_load', arguments: { targets: ['delete_file'] } }];
  }
  const rounds = new Map<string, number>();
  const requests = new Map<string, ModelRequest[]>();
  return {
    offered: (kind: string, round: number) => requests.get(kind)?.[round]?.tools?.map((t) => t.function.name) ?? [],
    handle: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/v1/models') {
        res.end('{"data":[{"id":"fake"}]}');
        return;
      }
      let raw = '';
      for await (const part of req) raw += String(part);
      const request = JSON.parse(raw) as ModelRequest;
      const kind = [...request.messages]
        .reverse()
        .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content in steps)?.content as
        | string
        | undefined;
      if (!request.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'title',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const round = rounds.get(kind ?? '') ?? 0;
      let tool: ToolCall | undefined;
      if (kind) {
        rounds.set(kind, round + 1);
        const recorded = requests.get(kind) ?? [];
        recorded.push(request);
        requests.set(kind, recorded);
        tool = steps[kind]?.[round];
      }
      respond(res, tool, `call-${kind}-${round}`);
    },
  };
}

function respond(res: ServerResponse, tool: ToolCall | undefined, callId: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish_reason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ role: 'assistant', content: '' });
  if (tool) {
    chunk({
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
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
