/**
 * The writer half of test/crash-recovery.mjs: append one ledger event per save,
 * forever, so the parent can SIGKILL this process inside a write.
 *
 * It writes with server/src/json-store.ts — the storage layer the task ledger must
 * use (PLAN.md: no second store) — so the crash guarantee is checked against the
 * real atomic write, temp file then rename.
 *
 * Run by the parent, not by hand:
 *   node --experimental-transform-types test/crash-recovery-child.mjs <home>
 */
import { join } from 'node:path';
import { JsonFileWriter } from '../src/json-store.ts';

const home = process.argv[2];
if (!home) {
  console.error('usage: node --experimental-transform-types crash-recovery-child.mjs <home>');
  process.exit(2);
}

const file = join(home, 'task-ledger.json');
const writer = new JsonFileWriter(file);
const events = [];
let seq = 0;

for (;;) {
  seq += 1;
  events.push({ seq, type: 'run-progress', at: Date.now(), detail: `step ${seq}` });
  await new Promise((resolve, reject) => {
    writer.write({ events }, resolve).catch(reject);
  });
  // The parent reads these lines to know which save the host had committed.
  process.stdout.write(`saved ${seq}\n`);
}
