import {
  ApprovalSettingsSchema,
  message,
  text,
  type ApprovalActor,
  type ApprovalInboxView,
  type ApprovalItem,
  type ApprovalSettings,
  type TaskSnapshot,
} from '@swiftnest/core';
import type { Nest } from '@swiftnest/core';
import { JsonFileWriter, readJsonFile } from './json-store.js';

interface Pending {
  item: ApprovalItem;
  settle: (allowed: boolean) => Promise<unknown>;
  timer: ReturnType<typeof setTimeout>;
}
const SYSTEM: ApprovalActor = { who: 'system', device: 'server' };

/** Sole decision owner. Claim synchronously, audit before dispatch, and never retry a source grant. */
export class ApprovalInbox {
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();
  private closed = false;
  private offTasks: () => void;
  private writer: JsonFileWriter;
  private settings: ApprovalSettings;
  private stop: () => void;
  constructor(
    private nest: Nest,
    file: string,
    defaults: unknown,
    private language: () => 'en' | 'zh-CN',
    private changed: () => void,
  ) {
    this.writer = new JsonFileWriter(file);
    this.settings = ApprovalSettingsSchema.parse(readJsonFile(file) ?? defaults ?? {});
    this.offTasks = nest.tasks.onChange((task) => {
      if (task.state !== 'pending_approval' && this.pending.has(task.id))
        void this.answer(task.id, false, SYSTEM).catch(() => {});
    });
    this.stop = nest.tasks.manageApprovals(
      (task) => this.addTask(task),
      (id, allowed) => this.answer(id, allowed, { who: 'owner', device: 'server' }),
    );
  }
  view(): ApprovalInboxView {
    return structuredClone({ items: [...this.pending.values()].map(({ item }) => item), settings: this.settings });
  }
  async configure(value: unknown): Promise<ApprovalInboxView> {
    const settings = ApprovalSettingsSchema.parse(value);
    await this.writer.write(settings, () => {
      this.settings = settings;
    });
    this.changed();
    return this.view();
  }
  add(input: Omit<ApprovalItem, 'createdAt' | 'expiresAt' | 'state'>, settle: Pending['settle']): void {
    if (this.closed || this.seen.has(input.id)) throw new Error('Approval unavailable');
    this.seen.add(input.id);
    const now = Date.now();
    const item: ApprovalItem = {
      ...structuredClone(input),
      state: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.settings.timeouts[input.kind]).toISOString(),
    };
    const timer = setTimeout(() => void this.expire(input.id).catch(() => {}), this.settings.timeouts[input.kind]);
    timer.unref();
    this.pending.set(item.id, { item, settle, timer });
    this.changed();
    if (this.settings.autoAllowLowRisk && item.risk === 'read') void this.answer(item.id, true, SYSTEM).catch(() => {});
  }
  private addTask(task: TaskSnapshot): void {
    const kind = task.capability === 'transfer' && task.tool === 'receive' ? 'transfer' : 'device';
    const key = kind === 'transfer' ? 'inboxTransferSummary' : 'inboxDeviceSummary';
    const summary = (language: 'en' | 'zh-CN') => message(key, language, [task.device, task.tool]);
    this.add(
      {
        id: task.id,
        kind,
        requester: task.client.name ?? task.client.id,
        device: task.device,
        tool: task.tool,
        args: task.args,
        risk: task.risk,
        summary: summary(this.language()),
        displayReason: { en: summary('en'), 'zh-CN': summary('zh-CN') },
      },
      (allowed) => this.nest.tasks.settleApproval(task.id, allowed, text('appOwner')),
    );
  }
  async answer(id: string, allowed: boolean, actor: ApprovalActor, expired = false): Promise<ApprovalInboxView> {
    const entry = this.pending.get(id);
    if (!entry) throw new Error('Approval is no longer pending');
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const overdue = expired || Date.parse(entry.item.expiresAt) <= Date.now();
    const accept = allowed && !overdue;
    entry.item.state = overdue ? 'expired' : accept ? 'allowed' : 'denied';
    this.changed();
    try {
      await this.record(entry.item, actor, accept);
    } catch (error) {
      await entry.settle(false);
      throw error;
    }
    await entry.settle(accept);
    return this.view();
  }
  expire(id: string): Promise<ApprovalInboxView> {
    return this.answer(id, false, SYSTEM, true);
  }
  private record(item: ApprovalItem, actor: ApprovalActor, allowed: boolean) {
    return this.nest.audit.append({
      at: new Date().toISOString(),
      taskId: item.id,
      device: item.device,
      capability: item.kind,
      tool: item.tool,
      args: item.args,
      client: { id: item.sessionId ? `dsh:${item.sessionId}` : item.requester, name: item.requester },
      state: allowed ? 'running' : 'denied',
      approval: {
        kind: item.kind,
        state: item.state,
        answeredBy: actor.who,
        answeringDevice: actor.device,
        automatic: actor.who === 'system',
      },
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    const decisions = await Promise.allSettled([...this.pending.keys()].map((id) => this.answer(id, false, SYSTEM)));
    for (const decision of decisions) {
      if (decision.status === 'rejected') this.nest.logger.error(text('auditWriteFailedLog'), decision.reason);
    }
    this.stop();
    this.offTasks();
    await this.writer.flush();
  }
}
