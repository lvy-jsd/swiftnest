import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Nest, MemoryAuditLog, memoryLink, Perch, RulePolicy, ApprovalSettingsSchema } from '@swiftnest/core';
import type { ApprovalItem } from '@swiftnest/api';
import { ApprovalInbox } from '../src/approval-inbox.js';
import { loadConfig, validate } from '../src/config.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(defaults: unknown = {}) {
  const home = await mkdtemp(join(tmpdir(), 'inbox-unit-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const audit = new MemoryAuditLog();
  const nest = new Nest({ audit, policy: new RulePolicy([{ action: 'ask' }]) });
  const inbox = new ApprovalInbox(nest, join(home, 'approvals.json'), defaults, () => 'zh-CN', vi.fn());
  cleanup.push(() => nest.close());
  cleanup.push(() => inbox.close());
  return { nest, inbox, audit, home };
}
function input(id: string, kind: ApprovalItem['kind'] = 'dsh', risk: ApprovalItem['risk'] = 'sensitive') {
  return {
    id,
    kind,
    risk,
    requester: 'Test chat',
    summary: 'A request',
    args: { path: '/shared' },
    device: 'computer',
    tool: 'test',
  };
}
it('merges three sources and settles a raced answer exactly once with the answering identity', async () => {
  const { inbox, audit } = await setup();
  const settles = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];
  for (const [index, kind] of (['dsh', 'device', 'transfer'] as const).entries())
    inbox.add(input(kind, kind), settles[index]!);
  expect(inbox.view().items.map((item) => item.kind)).toEqual(['dsh', 'device', 'transfer']);
  const results = await Promise.allSettled([
    inbox.answer('dsh', true, { who: 'owner', device: 'phone' }),
    inbox.answer('dsh', false, { who: 'owner', device: 'laptop' }),
  ]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(settles[0]).toHaveBeenCalledExactlyOnceWith(true);
  expect(inbox.view().items.map((item) => item.id)).toEqual(['device', 'transfer']);
  expect(audit.entries).toEqual([
    expect.objectContaining({
      at: expect.any(String),
      approval: { kind: 'dsh', state: 'allowed', answeredBy: 'owner', answeringDevice: 'phone', automatic: false },
    }),
  ]);
  expect(() => inbox.add(input('dsh'), settles[0]!)).toThrow();
});
it('denies every kind on its own deadline and rejects late allows even if the timer has not run', async () => {
  const { inbox, audit } = await setup({ timeouts: { dsh: 1000, device: 2000, transfer: 3000 } });
  vi.useFakeTimers();
  const settle = vi.fn(async () => {});
  for (const kind of ['dsh', 'device', 'transfer'] as const) inbox.add(input(kind, kind), settle);
  await vi.advanceTimersByTimeAsync(1000);
  expect(inbox.view().items.map((item) => item.kind)).toEqual(['device', 'transfer']);
  vi.setSystemTime(Date.now() + 3000);
  await inbox.answer('device', true, { who: 'owner', device: 'phone' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(settle.mock.calls).toEqual([[false], [false], [false]]);
  expect(audit.entries.every((entry) => entry.state === 'denied' && entry.approval?.state === 'expired')).toBe(true);
});
it('keeps automatic low-risk approval off by default and never grants higher or unknown risk', async () => {
  const { inbox, audit } = await setup();
  const low = vi.fn(async () => {});
  inbox.add(input('low', 'device', 'read'), low);
  expect(low).not.toHaveBeenCalled();
  await inbox.configure({ autoAllowLowRisk: true });
  const automatic = vi.fn(async () => {});
  inbox.add(input('next-low', 'device', 'read'), automatic);
  inbox.add(
    input('write', 'transfer', 'write'),
    vi.fn(async () => {}),
  );
  inbox.add(
    input('unknown'),
    vi.fn(async () => {}),
  );
  await expect.poll(() => automatic.mock.calls.length).toBe(1);
  expect(automatic).toHaveBeenCalledWith(true);
  expect(inbox.view().items.map((item) => item.id)).toEqual(['low', 'write', 'unknown']);
  expect(audit.entries[0]?.approval).toMatchObject({
    automatic: true,
    answeredBy: 'system',
    answeringDevice: 'server',
  });
});
it('fails closed when audit cannot commit and never dispatches a grant', async () => {
  const { inbox, audit } = await setup();
  const settle = vi.fn(async () => {});
  inbox.add(input('test'), settle);
  vi.spyOn(audit, 'append').mockRejectedValueOnce(new Error('disk full'));
  await expect(inbox.answer('test', true, { who: 'owner', device: 'phone' })).rejects.toThrow('disk full');
  expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  expect(inbox.view().items).toEqual([]);
});
it('shares Nest decisions, classifies transfer receives once and removes cancelled requests', async () => {
  const { inbox, nest, audit } = await setup();
  const perch = new Perch({ device: 'computer' });
  perch.addCapability({
    manifest: {
      id: 'transfer',
      title: 'Transfer',
      tools: [{ name: 'receive', description: 'Receive', risk: 'write', inputSchema: { type: 'object' } }],
    },
    async invoke() {
      return { text: 'received' };
    },
  });
  nest.attach(memoryLink(perch));
  cleanup.push(() => perch.close());
  const first = await nest.call('computer__transfer__receive', {}, { id: 'sender' });
  expect(inbox.view().items).toMatchObject([{ id: first.id, kind: 'transfer', risk: 'write' }]);
  await nest.tasks.approve(first.id);
  expect(inbox.view().items).toEqual([]);
  expect((await nest.tasks.wait(first.id, 1000)).state).toBe('succeeded');
  const second = await nest.call('computer__transfer__receive', {}, { id: 'sender' });
  await nest.tasks.cancel(second.id);
  expect(inbox.view().items).toEqual([]);
  await expect.poll(() => audit.entries.filter((entry) => entry.approval).length).toBe(2);
});
it('validates config and saved settings and persists only the preferences', async () => {
  expect(ApprovalSettingsSchema.parse({})).toEqual({
    remind: true,
    autoAllowLowRisk: false,
    timeouts: { dsh: 600000, device: 600000, transfer: 600000 },
  });
  const { inbox, home } = await setup();
  await inbox.configure({ remind: false, timeouts: { transfer: 1000 } });
  expect(JSON.parse(await readFile(join(home, 'approvals.json'), 'utf8'))).toMatchObject({
    remind: false,
    timeouts: { transfer: 1000 },
  });
  for (const invalid of [
    { autoAllowLowRisk: 'yes' },
    { timeouts: { device: 0 } },
    { timeouts: { dsh: 86400001 } },
    { timeouts: { unknown: 1000 } },
  ]) {
    await expect(inbox.configure(invalid)).rejects.toThrow();
    expect(() => validate({ ...loadConfig(), approvals: invalid as never })).toThrow();
  }
});
