import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { stopChild } from '../src/kernel.js';

const fixture = fileURLToPath(new URL('./fixtures/lifecycle-kernel.mjs', import.meta.url));
const guard = fileURLToPath(new URL('../src/kernel-parent-guard.ts', import.meta.url));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it('clears escalation after normal stop and makes teardown idempotent', async () => {
  const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  cleanup.push(() => stopChild(child));
  await once(child, 'message');
  const kill = vi.spyOn(child, 'kill');
  await stopChild(child, 10_000);
  expect(kill.mock.calls).toEqual([['SIGTERM']]);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(child.listenerCount('exit')).toBe(0);
  await stopChild(child);
  expect(kill).toHaveBeenCalledTimes(1);
});

it('escalates an uncooperative owned child without touching an unrelated instance', async () => {
  const spawnFixture = (mode: string) =>
    spawn(process.execPath, [fixture], {
      env: { ...process.env, LIFECYCLE_MODE: mode },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  const unrelated = spawnFixture('ready');
  const stubborn = spawnFixture('ignore-term');
  cleanup.push(
    () => stopChild(unrelated),
    () => stopChild(stubborn),
  );
  await Promise.all([once(unrelated, 'message'), once(stubborn, 'message')]);
  await stopChild(stubborn, 30);
  expect(stubborn.signalCode).toBe('SIGKILL');
  expect(alive(unrelated.pid!)).toBe(true);
});

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'reaps the kernel when its parent receives %s',
  async (signal) => {
    const parent = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/lifecycle-parent.mjs', import.meta.url)), guard, fixture, 'ignore-term'],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    cleanup.push(() => stopChild(parent));
    const [message] = (await once(parent, 'message')) as [{ pid: number; port: number }];
    cleanup.push(async () => {
      if (alive(message.pid)) {
        try {
          process.kill(message.pid, 'SIGKILL');
        } catch {}
      }
    });
    expect((await fetch(`http://127.0.0.1:${message.port}`)).status).toBe(200);
    parent.kill(signal);
    await once(parent, 'exit');
    // A reparented process may remain a zombie until init reaps it; the live listener must be gone.
    await expect
      .poll(
        async () => {
          try {
            await fetch(`http://127.0.0.1:${message.port}`, { signal: AbortSignal.timeout(200) });
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 8000 },
      )
      .toBe(false);
  },
  12_000,
);
