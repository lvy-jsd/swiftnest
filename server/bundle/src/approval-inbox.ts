/** A server-side answerer keeps risk-gate requests available even with no open chat. */
import type { CoreConfig } from './core.js';
interface SessionEvent {
  type: string;
  data: Record<string, unknown>;
}
interface Request {
  agent: { id: string; session: { seq: number; title?: string; eventAt(seq: number): SessionEvent | undefined } };
  toolName: string;
  callId?: string;
  reason?: string;
  displayReason?: { en: string; [locale: string]: string };
  signal?: AbortSignal;
}
interface Context {
  on(event: 'approval/request', listener: (request: Request) => Promise<string>, prepend: boolean): () => void;
  effect(fn: () => () => void, label?: string): void;
}
function details(request: Request) {
  const session = request.agent.session;
  let id: unknown;
  let title: string | undefined;
  let foundArgs = false;
  let args: Record<string, unknown> = {};
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (!title && event?.type === 'session/title' && typeof event.data.title === 'string') title = event.data.title;
    if (!id && event?.type === 'approval/asked' && event.data.callId === request.callId) id = event.data.id;
    if (!foundArgs && event?.type === 'tool/call' && event.data.callId === request.callId) {
      foundArgs = true;
      try {
        args = JSON.parse(String(event.data.arguments));
      } catch {
        args = { arguments: event.data.arguments };
      }
    }
  }
  if (typeof id !== 'string') throw new Error('Missing approval audit id');
  return { id, args, requester: title ?? request.agent.id };
}
export function approvalAnswerer(ctx: Context, config: CoreConfig): void {
  if (!config.devicesAdminUrl || !config.devicesAdminToken) return;
  ctx.effect(
    () =>
      ctx.on(
        'approval/request',
        async (request) => {
          try {
            const response = await fetch(`${config.devicesAdminUrl}/swiftnest/control/approvals/request`, {
              method: 'POST',
              headers: { authorization: `Bearer ${config.devicesAdminToken}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                ...details(request),
                sessionId: request.agent.id,
                tool: request.toolName,
                summary: request.reason ?? request.toolName,
                displayReason: request.displayReason,
              }),
              signal: request.signal,
            });
            return response.ok && (await response.json()) === true ? 'allowed-once' : 'rejected';
          } catch {
            return 'unavailable';
          }
        },
        true,
      ),
    'swiftnest-core: approval inbox',
  );
}
