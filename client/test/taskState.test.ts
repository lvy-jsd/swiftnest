import { describe, expect, it } from 'vitest';
import { compareTasks, findTask, groupTasks, taskSummary, updatedAtMs, type TaskView } from '../src/taskState';

function task(overrides: Partial<TaskView> & Pick<TaskView, 'id' | 'status'>): TaskView {
  return { updatedAt: 1_000, events: [], ...overrides };
}

describe('task ledger reading', () => {
  it('puts work in flight first and anything unknown last, never dropping it', () => {
    const groups = groupTasks([
      task({ id: 'a', status: 'failed' }),
      task({ id: 'b', status: 'running' }),
      task({ id: 'c', status: 'parked' }),
      task({ id: 'd', status: 'completed' }),
      task({ id: 'e', status: 'waiting' }),
      task({ id: 'f', status: 'queued' }),
      task({ id: 'g', status: 'abandoned' }),
    ]);
    expect(groups.map((group) => group.status)).toEqual([
      'running',
      'waiting',
      'queued',
      'completed',
      'failed',
      'abandoned',
      'parked',
    ]);
  });

  it('orders unknown statuses alphabetically so the list does not jump between polls', () => {
    const first = groupTasks([task({ id: 'a', status: 'zeta' }), task({ id: 'b', status: 'alpha' })]);
    const second = groupTasks([task({ id: 'b', status: 'alpha' }), task({ id: 'a', status: 'zeta' })]);
    expect(first.map((group) => group.status)).toEqual(['alpha', 'zeta']);
    expect(second.map((group) => group.status)).toEqual(first.map((group) => group.status));
  });

  it('shows the newest task first, and breaks a same-second tie on id', () => {
    const ordered = [
      task({ id: 'b', status: 'running', updatedAt: 2_000 }),
      task({ id: 'a', status: 'running', updatedAt: 2_000 }),
      task({ id: 'c', status: 'running', updatedAt: 3_000 }),
    ].sort(compareTasks);
    expect(ordered.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('reads a millisecond timestamp and an ISO string the same way', () => {
    const iso = new Date('2026-11-08T08:00:00Z').toISOString();
    expect(updatedAtMs(iso)).toBe(Date.parse(iso));
    expect(updatedAtMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('treats an unreadable timestamp as zero instead of printing 1970 as if it were true', () => {
    expect(updatedAtMs('not a date')).toBe(0);
    expect(updatedAtMs(Number.NaN)).toBe(0);
  });

  it('summarises the step count and the newest event by seq, not by array order', () => {
    const summary = taskSummary(
      task({
        id: 'a',
        status: 'running',
        events: [
          { seq: 4, kind: 'step', at: 1, payload: {} },
          { seq: 2, kind: 'start', at: 0, payload: {} },
          { seq: 7, kind: 'done', at: 2, payload: {} },
        ],
      }),
    );
    expect(summary.steps).toBe(3);
    expect(summary.latest?.kind).toBe('done');
  });

  it('reports no latest event for a task the ledger recorded nothing for', () => {
    expect(taskSummary(task({ id: 'a', status: 'queued' })).latest).toBeUndefined();
  });

  it('finds a task by id and returns nothing for an unknown or missing one', () => {
    const tasks = [task({ id: 'a', status: 'running' }), task({ id: 'b', status: 'completed' })];
    expect(findTask(tasks, 'b')?.status).toBe('completed');
    expect(findTask(tasks, 'ghost')).toBeUndefined();
    expect(findTask(tasks, undefined)).toBeUndefined();
  });
});
