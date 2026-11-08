/**
 * The crash-recovery script runs under the normal test gate.
 *
 * The script itself (test/crash-recovery.mjs) spawns writer processes and SIGKILLs
 * them mid-write; that has to be a real process, so this test runs it and fails on a
 * non-zero exit. Nothing here needs a build: the writer loads server/src/json-store.ts
 * through Node's type transform, and each round uses its own temp home.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('./crash-recovery.mjs', import.meta.url));

it('a write killed mid-flight leaves a state the next boot agrees with', async () => {
  const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', script], {
      env: { ...process.env, ROUNDS: '3' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += String(chunk);
    });
    child.on('close', (code) => resolve({ code, output }));
  });
  // The script's own assertions name the round that broke; show them on a failure.
  expect(result.output, `crash-recovery failed (exit ${result.code})`).toContain('all recovered');
  expect(result.code, result.output).toBe(0);
}, 120_000);
