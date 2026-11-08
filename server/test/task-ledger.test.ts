/**
 * The task ledger records each live-work change once per DS Bot `liveKey`.
 *
 * The ledger is only worth reading if three things hold:
 *   - a change seen twice (a repeated poll, a restart) lands once;
 *   - a real change (a run finishing) lands as its own event and moves the status;
 *   - a finished unit stays in the list instead of vanishing between polls.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TaskLedger, type LiveWork } from '../src/task-ledger.js';

/** A `live.work` block as DS Bot returns it, with the parts a test cares about filled in. */
function work(bots: Record<string, unknown> = {}, rooms: Record<string, unknown> = {}): LiveWork {
  return { bots, rooms, approvals: [], waiting: {}, turns: {}, steered: {} };
}

it('records a live-work change once per liveKey, keeps it across a restart and keeps a finished unit listed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-ledger-'));
  try {
    const file = join(home, 'task-ledger.json');
    const ledger = new TaskLedger(file);
    const running = work({ b1: { status: 'running', step: 2 } });

    expect(ledger.append('live-1', running)?.seq).toBe(1);
    // The same change polled again: no second event.
    expect(ledger.append('live-1', running)).toBeUndefined();
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.get('b1')?.events).toHaveLength(1);
    expect(ledger.get('b1')?.status).toBe('running');

    // The run finishes: a real change, so its own event, and the unit reads completed.
    const finished = work();
    expect(ledger.append('live-2', finished)?.seq).toBe(2);
    await ledger.flush();
    expect(ledger.get('b1')?.events.map((event) => event.liveKey)).toEqual(['live-1', 'live-2']);
    expect(ledger.get('b1')?.status).toBe('completed');
    expect(ledger.get('b1')?.updatedAt).toBe(ledger.get('b1')?.events.at(-1)?.at);
    // A finished unit stays in the list rather than vanishing from the latest snapshot.
    expect(ledger.list().map((task) => task.id)).toEqual(['b1']);

    // A restart keeps the dedupe set: old changes stay recorded once, new ones append.
    const reopened = new TaskLedger(file);
    expect(reopened.append('live-1', running)).toBeUndefined();
    expect(reopened.append('live-2', finished)).toBeUndefined();
    expect(reopened.get('b1')?.events).toHaveLength(2);
    expect(reopened.append('live-3', work({ b2: { status: 'running' } }))?.seq).toBe(3);
    expect(Object.fromEntries(reopened.list().map((task) => [task.id, task.status]))).toEqual({
      b1: 'completed',
      b2: 'running',
    });
    // The writer runs in the background; let the last append land before the home is removed.
    await reopened.flush();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
