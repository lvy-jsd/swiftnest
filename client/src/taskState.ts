/**
 * Task ledger reading, kept away from the DOM.
 *
 * The ledger is the server's record of what each work unit did, one entry per
 * `live.work` change (`{ id, status, updatedAt, events }`). Grouping and ordering
 * live here so the page cannot invent an order of its own, and so the rules can be
 * tested without a server.
 */
export interface LedgerEvent {
  seq: number;
  kind: string;
  at: number;
  payload: unknown;
}

export interface TaskView {
  id: string;
  status: string;
  updatedAt: number | string;
  events: readonly LedgerEvent[];
}

export interface TaskGroup {
  status: string;
  tasks: TaskView[];
}

/**
 * Work in flight first, then the outcomes, then anything we have not seen yet.
 * Unknown statuses still show up — a new server status must not hide a task.
 */
const STATUS_PRIORITY = ['running', 'waiting', 'queued', 'completed', 'failed'] as const;

function statusRank(status: string): number {
  const rank = STATUS_PRIORITY.indexOf(status as (typeof STATUS_PRIORITY)[number]);
  return rank === -1 ? STATUS_PRIORITY.length : rank;
}

/** Milliseconds since the epoch. Accepts an ISO string too, so a shape change cannot print 1970. */
export function updatedAtMs(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Newest first; ties break on id so two tasks updated in the same second keep a stable order. */
export function compareTasks(a: TaskView, b: TaskView): number {
  const updated = updatedAtMs(b.updatedAt) - updatedAtMs(a.updatedAt);
  if (updated !== 0) return updated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function groupTasks(tasks: readonly TaskView[]): TaskGroup[] {
  const byStatus = new Map<string, TaskView[]>();
  for (const task of tasks) {
    const group = byStatus.get(task.status);
    if (group) group.push(task);
    else byStatus.set(task.status, [task]);
  }
  return [...byStatus.entries()]
    .sort(([a], [b]) => statusRank(a) - statusRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([status, grouped]) => ({ status, tasks: grouped.sort(compareTasks) }));
}

/** The step count and the newest event, for a card that does not open the whole record. */
export function taskSummary(task: TaskView): { steps: number; latest?: LedgerEvent } {
  let latest: LedgerEvent | undefined;
  for (const event of task.events) {
    if (!latest || event.seq > latest.seq) latest = event;
  }
  return { steps: task.events.length, latest };
}

/** The task a route points at, or `undefined` for an id the ledger does not know. */
export function findTask(tasks: readonly TaskView[], id: string | undefined): TaskView | undefined {
  if (!id) return undefined;
  return tasks.find((task) => task.id === id);
}
