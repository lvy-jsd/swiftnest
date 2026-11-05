import type { IncomingMessage, ServerResponse } from 'node:http';
import { DshApprovalRequestSchema, text, type ApprovalActor } from '@swiftnest/core';
import type { DeviceHub } from './device-routes.js';
import { HttpError, openEventStream, readJsonObject } from './http.js';

export async function handleApprovalRoute(
  hub: DeviceHub,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<unknown> {
  const path = url.pathname;
  if (path === '/swiftnest/control/approvals/request' && req.method === 'POST') return requestApproval(hub, req, res);
  if (!path.startsWith('/swiftnest/api/approvals')) throw new HttpError(404, text('notFound'));
  if (path === '/swiftnest/api/approvals' && req.method === 'GET') return hub.approvals.view();
  if (path === '/swiftnest/api/approvals/events' && req.method === 'GET') {
    openEventStream(res, hub.streams, { type: 'approvals-changed' });
    return;
  }
  if (path === '/swiftnest/api/approvals/settings' && req.method === 'POST') {
    try {
      return await hub.approvals.configure(await readJsonObject(req, 4096, text('inboxInvalidSettings')));
    } catch {
      throw new HttpError(400, text('inboxInvalidSettings'));
    }
  }
  const match = /^\/swiftnest\/api\/approvals\/([^/]+)\/(allow|deny)$/.exec(path);
  if (match && req.method === 'POST') {
    try {
      return await hub.approvals.answer(decodeURIComponent(match[1]!), match[2] === 'allow', approvalActor(req));
    } catch {
      throw new HttpError(409, text('approvalNoLongerPending'));
    }
  }
  throw new HttpError(404, text('notFound'));
}
export function approvalActor(req: IncomingMessage): ApprovalActor {
  const device = req.headers['x-swiftnest-answering-device'];
  return { who: 'owner', device: typeof device === 'string' ? device : 'server' };
}
async function requestApproval(hub: DeviceHub, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = DshApprovalRequestSchema.safeParse(await readJsonObject(req, 32768, text('deviceArgumentsTooLarge')));
  if (!parsed.success) throw new HttpError(400, text('expectedObjectArguments'));
  if (res.destroyed) return;
  const input = parsed.data;
  const id = `dsh:${input.id}`;
  return new Promise<void>((resolve, reject) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      clearInterval(heartbeat);
      res.off('close', closed);
      resolve();
    };
    const closed = () => {
      clearInterval(heartbeat);
      void hub.approvals.answer(id, false, { who: 'system', device: 'server' }).catch(() => {});
      resolve();
    };
    res.once('close', closed);
    try {
      hub.approvals.add({ ...input, id, kind: 'dsh', risk: 'sensitive', device: 'server' }, async (allowed) => {
        res.end(JSON.stringify(allowed));
        finish();
      });
      // JSON whitespace keeps long consent waits inside fetch's idle/headers deadlines.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.write(' ');
      heartbeat = setInterval(() => {
        if (!res.write(' ')) res.destroy();
      }, 15000);
      heartbeat.unref();
    } catch (error) {
      clearInterval(heartbeat);
      res.off('close', closed);
      reject(error);
    }
  });
}
