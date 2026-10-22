/**
 * Task state machine: queued → (pending_approval) → running → succeeded | failed | denied | timed_out | cancelled.
 * Every transition is written to the audit log with the raw arguments. Calls that need approval or take long return
 * a task id immediately, so the agent can keep working and come back for the result (design §4.2).
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { TERMINAL_STATES, type ClientRef, type Risk, type SwiftnestError, type TaskSnapshot, type TaskState } from "@swiftnest/protocol";
import type { AuditLog } from "./audit.js";
import { SwiftnestFailure } from "./errors.js";
import type { PerchConnection } from "./link.js";
import type { Logger } from "./log.js";
import type { Policy } from "./policy.js";

export interface CallRequest {
  client: ClientRef;
  device: string;
  capability: string;
  tool: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface TaskManagerOptions {
  connection(device: string): PerchConnection | undefined;
  defaultTimeout(device: string, capability: string, tool: string): number | undefined;
  policy: Policy;
  audit: AuditLog;
  logger: Logger;
  /** How long a call may wait for a person before it is denied (default 10 min). */
  approvalTimeoutMs?: number;
  /** Concurrent running calls per device (default 4); extra calls queue. */
  maxConcurrentPerDevice?: number;
}

interface Internal {
  snap: TaskSnapshot;
  timeoutMs: number;
  approvalTimer?: NodeJS.Timeout;
}

export class TaskManager {
  private tasks = new Map<string, Internal>();
  private events = new EventEmitter();
  private active = new Map<string, number>();
  private waiting = new Map<string, (() => void)[]>();

  constructor(private o: TaskManagerOptions) {
    this.events.setMaxListeners(0);
  }

  /** Submit a call. Resolves once the task is accepted (not when it finishes); use `wait` for the outcome. */
  async submit(req: CallRequest): Promise<TaskSnapshot> {
    const args = req.args ?? {};
    const now = new Date().toISOString();
    const snap: TaskSnapshot = {
      id: randomUUID(),
      device: req.device,
      capability: req.capability,
      tool: req.tool,
      args,
      client: req.client,
      state: "queued",
      risk: "exec",
      createdAt: now,
      updatedAt: now,
    };
    const conn = this.o.connection(req.device);
    const timeoutMs = req.timeoutMs ?? this.o.defaultTimeout(req.device, req.capability, req.tool) ?? 30_000;
    const t: Internal = { snap, timeoutMs };
    this.tasks.set(snap.id, t);
    if (!conn) {
      await this.finish(t, "failed", {
        error: new SwiftnestFailure("DEVICE_OFFLINE", `Device "${req.device}" is not connected.`, "Check that its Perch is running, then list devices again.", true).toJSON(),
      });
      return this.snapshot(snap.id);
    }
    let risk: Risk;
    let riskReason: string | undefined;
    try {
      ({ risk, reason: riskReason } = await conn.classify(req.capability, req.tool, args));
    } catch (e) {
      await this.finish(t, "failed", { error: SwiftnestFailure.from(e, "CLASSIFY_FAILED") });
      return this.snapshot(snap.id);
    }
    snap.risk = risk;
    const decision = await this.o.policy.decide({ ...req, args, risk, reason: riskReason });
    snap.reason = decision.reason;
    await this.record(t);
    if (decision.action === "deny") {
      await this.finish(t, "denied", {
        error: new SwiftnestFailure("DENIED", `Policy denied ${req.capability}.${req.tool} on ${req.device}: ${decision.reason}.`, "Ask the owner to change the permission for this tool if it should be allowed.").toJSON(),
      });
    } else if (decision.action === "ask") {
      await this.transition(t, "pending_approval");
      t.approvalTimer = setTimeout(() => {
        void this.deny(snap.id, "approval expired");
      }, this.o.approvalTimeoutMs ?? 600_000);
    } else {
      void this.run(t);
    }
    return this.snapshot(snap.id);
  }

  /** A person approved a pending call. */
  async approve(taskId: string, by = "owner"): Promise<TaskSnapshot> {
    const t = this.require(taskId);
    if (t.snap.state !== "pending_approval") throw new SwiftnestFailure("NOT_PENDING", `Task ${taskId} is ${t.snap.state}, not waiting for approval.`);
    clearTimeout(t.approvalTimer);
    t.snap.reason = `${t.snap.reason ?? ""}; approved by ${by}`.replace(/^; /, "");
    void this.run(t);
    return this.snapshot(taskId);
  }

  async deny(taskId: string, why = "denied by owner"): Promise<TaskSnapshot> {
    const t = this.require(taskId);
    if (t.snap.state !== "pending_approval") return this.snapshot(taskId);
    clearTimeout(t.approvalTimer);
    await this.finish(t, "denied", { error: new SwiftnestFailure("DENIED", `Not approved: ${why}.`).toJSON() });
    return this.snapshot(taskId);
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    const t = this.require(taskId);
    if (TERMINAL_STATES.has(t.snap.state)) return this.snapshot(taskId);
    clearTimeout(t.approvalTimer);
    if (t.snap.state === "running") this.o.connection(t.snap.device)?.cancel(taskId);
    await this.finish(t, "cancelled", { error: new SwiftnestFailure("CANCELLED", "Cancelled by request.").toJSON() });
    return this.snapshot(taskId);
  }

  /**
   * Wait until the task ends or `ms` passes; returns the latest snapshot either way.
   * `untilPending`: also return as soon as the task waits for a person — there is nothing to wait for then,
   * so the agent gets "waiting for approval + task id" immediately and can carry on.
   */
  wait(taskId: string, ms: number, opts: { untilPending?: boolean } = {}): Promise<TaskSnapshot> {
    const t = this.require(taskId);
    const settled = (s: TaskState) => TERMINAL_STATES.has(s) || (opts.untilPending === true && s === "pending_approval");
    if (settled(t.snap.state)) return Promise.resolve(this.snapshot(taskId));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(taskId, onChange);
        resolve(this.snapshot(taskId));
      };
      const onChange = (s: TaskSnapshot) => settled(s.state) && done();
      const timer = setTimeout(done, ms);
      this.events.on(taskId, onChange);
    });
  }

  get(taskId: string): TaskSnapshot | undefined {
    return this.tasks.has(taskId) ? this.snapshot(taskId) : undefined;
  }

  list(filter: { state?: TaskState } = {}): TaskSnapshot[] {
    return [...this.tasks.values()].map((t) => structuredClone(t.snap)).filter((s) => !filter.state || s.state === filter.state);
  }

  /** Subscribe to every task change (panels, approval surfaces). */
  onChange(fn: (s: TaskSnapshot) => void): () => void {
    this.events.on("*", fn);
    return () => this.events.off("*", fn);
  }

  // ---------------------------------------------------------------- internals

  private async run(t: Internal): Promise<void> {
    const dev = t.snap.device;
    const limit = this.o.maxConcurrentPerDevice ?? 4;
    if ((this.active.get(dev) ?? 0) >= limit) {
      await this.transition(t, "queued");
      await new Promise<void>((r) => this.waiting.set(dev, [...(this.waiting.get(dev) ?? []), r]));
      if (TERMINAL_STATES.has(t.snap.state)) return this.release(dev, false); // cancelled while queued
    }
    this.active.set(dev, (this.active.get(dev) ?? 0) + 1);
    await this.transition(t, "running");
    const conn = this.o.connection(dev);
    try {
      if (!conn) throw new SwiftnestFailure("DEVICE_OFFLINE", `Device "${dev}" disconnected.`, "Wait for it to reconnect, then retry.", true);
      const res = await conn.invoke({ taskId: t.snap.id, capability: t.snap.capability, tool: t.snap.tool, args: t.snap.args, timeoutMs: t.timeoutMs });
      if (t.snap.state !== "running") return; // cancelled meanwhile
      if (res.ok) await this.finish(t, "succeeded", { result: res.result });
      else await this.finish(t, res.error?.code === "TIMEOUT" ? "timed_out" : res.error?.code === "CANCELLED" ? "cancelled" : "failed", { error: res.error });
    } catch (e) {
      if (t.snap.state === "running") await this.finish(t, "failed", { error: SwiftnestFailure.from(e, "TOOL_FAILED") });
    } finally {
      this.release(dev, true);
    }
  }

  private release(dev: string, wasActive: boolean) {
    if (wasActive) this.active.set(dev, Math.max(0, (this.active.get(dev) ?? 1) - 1));
    const next = this.waiting.get(dev)?.shift();
    next?.();
  }

  private async finish(t: Internal, state: TaskState, extra: { result?: TaskSnapshot["result"]; error?: SwiftnestError }) {
    if (TERMINAL_STATES.has(t.snap.state)) return;
    if (extra.result) t.snap.result = extra.result;
    if (extra.error) t.snap.error = extra.error;
    await this.transition(t, state);
  }

  private async transition(t: Internal, state: TaskState) {
    t.snap.state = state;
    t.snap.updatedAt = new Date().toISOString();
    await this.record(t);
    const s = structuredClone(t.snap);
    this.events.emit(t.snap.id, s);
    this.events.emit("*", s);
  }

  private async record(t: Internal) {
    const s = t.snap;
    try {
      await this.o.audit.append({
        at: new Date().toISOString(),
        taskId: s.id,
        client: s.client,
        device: s.device,
        capability: s.capability,
        tool: s.tool,
        args: s.args,
        state: s.state,
        reason: s.reason,
        error: s.error,
      });
    } catch (e) {
      this.o.logger.error("audit write failed", e);
    }
  }

  private require(taskId: string): Internal {
    const t = this.tasks.get(taskId);
    if (!t) throw new SwiftnestFailure("UNKNOWN_TASK", `No task ${taskId}.`, "Task ids come from the response of the original call.");
    return t;
  }

  private snapshot(taskId: string): TaskSnapshot {
    return structuredClone(this.require(taskId).snap);
  }
}
