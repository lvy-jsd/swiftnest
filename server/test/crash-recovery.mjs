/**
 * Crash recovery, repeatable: kill a writer in the middle of a state write, then prove
 * the next boot reads a state that agrees with the last save it reported.
 *
 *   node --experimental-transform-types server/test/crash-recovery.mjs
 *   ROUNDS=50 node --experimental-transform-types server/test/crash-recovery.mjs   # soak
 *
 * The writer appends events through server/src/json-store.ts, the atomic temp-then-rename
 * write (PLAN.md forbids a second store), so this covers the ledger's crash guarantee.
 * When server/src/task-ledger.ts lands, its append path replaces the probe write in
 * crash-recovery-child.mjs and the assertions below stay as they are.
 *
 * Each round gets a fresh home and a SIGKILL at a random moment. After it, the file must:
 *   - parse (a torn or truncated write fails here),
 *   - hold a contiguous seq 1..K with K >= the last save the writer reported,
 *   - be readable again by readJsonFile, as the next boot would read it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from '../src/json-store.ts';

const NODE_FLAGS = ['--experimental-transform-types', '--no-warnings'];
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const childPath = fileURLToPath(new URL('./crash-recovery-child.mjs', import.meta.url));

// Watches the writer's "saved N" lines until N reaches target. The counter keeps
// running after that, so the last value read before the kill is the last save the
// writer itself claimed.
function watchSaves(child, target) {
  const seen = { acked: 0 };
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      const match = /^saved (\d+)$/.exec(line.trim());
      if (match) seen.acked = Number(match[1]);
    }
  });
  const reached = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (seen.acked >= target) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
    child.on('error', (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearInterval(timer);
      if (seen.acked < target) reject(new Error(`writer exited early with ${code} before save ${target}`));
    });
  });
  return { seen, reached };
}

function exited(child) {
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
}

async function round(n) {
  const home = mkdtempSync(join(tmpdir(), 'swiftnest-crash-'));
  try {
    const writer = spawn(process.execPath, [...NODE_FLAGS, childPath, home], { stdio: ['ignore', 'pipe', 'pipe'] });
    writer.stderr.setEncoding('utf8');
    writer.stderr.on('data', () => {});
    const saves = watchSaves(writer, 3);
    await saves.reached;
    // Let a save begin, then kill inside it. The random delay lands variously
    // before the write, inside it, and right after the rename.
    await delay(Math.random() * 4);
    writer.kill('SIGKILL');
    const end = await exited(writer);
    assert.equal(end.signal, 'SIGKILL', `round ${n}: writer was meant to be killed by SIGKILL`);

    // A truncated or interleaved write throws in JSON.parse; that is the failure caught here.
    const parsed = JSON.parse(readFileSync(join(home, 'task-ledger.json'), 'utf8'));
    const seqs = parsed.events.map((event) => event.seq);
    const expected = Array.from({ length: seqs.length }, (_, index) => index + 1);
    assert.deepEqual(seqs, expected, `round ${n}: ledger events are not a contiguous run`);
    // The writer may finish a save whose "saved" line never reaches the pipe, so the
    // file can be ahead of the last acknowledged number; it can never be behind it.
    assert.ok(
      seqs.length >= saves.seen.acked,
      `round ${n}: ${seqs.length} events saved but ${saves.seen.acked} acknowledged`,
    );
    for (const event of parsed.events)
      assert.ok(
        typeof event.type === 'string' && event.detail === `step ${event.seq}`,
        `round ${n}: event ${event.seq} is not the record that was written`,
      );

    // The next boot must read the same state, exactly as a restarted host would.
    const reloaded = readJsonFile(join(home, 'task-ledger.json'));
    assert.equal(
      reloaded.events.length,
      seqs.length,
      `round ${n}: boot loaded ${reloaded.events.length} events, file holds ${seqs.length}`,
    );

    return { acked: saves.seen.acked, count: seqs.length };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const results = [];
for (let n = 1; n <= ROUNDS; n += 1) results.push(await round(n));
const counts = results.map((result) => result.count);
console.log(
  `crash-recovery: ${ROUNDS} rounds, ${Math.min(...counts)}-${Math.max(...counts)} events each, all recovered`,
);
