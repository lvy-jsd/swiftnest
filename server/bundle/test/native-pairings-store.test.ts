import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativePairings, type NativeGrant } from '../src/native-pairings-store.js';

const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'native-pairings-'));
  homes.push(home);
  const file = join(home, 'native-pairings.json');
  return { store: new NativePairings(file), file };
}
const grant: NativeGrant = { principal: { kind: 'owner' }, interactions: 'none' };

it('issues a host-bound, hashed, private grant and verifies it after reopening', () => {
  const { store, file } = setup();
  const { credential, record } = store.issue(grant, 'server:3077');
  expect(credential).toHaveLength(43);
  expect(readFileSync(file, 'utf8')).not.toContain(credential);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(new NativePairings(file).verify(credential, 'server:3077')).toEqual(record);
  expect(record).toMatchObject(grant);
  expect(store.verify(credential, 'other:3077')).toBeUndefined();
  expect(store.verify('forged', 'server:3077')).toBeUndefined();
  expect(store.verify(`${credential.slice(0, -1)}!`, 'server:3077')).toBeUndefined();
});
it('rotates without extending expiry or authority, rejecting the old credential permanently', () => {
  const { store, file } = setup();
  const { credential, record } = store.issue(grant, 'server');
  const rotated = store.rotate(credential, 'server')!;
  expect(rotated.credential).not.toBe(credential);
  expect(store.verify(credential, 'server')).toBeUndefined();
  expect(store.verify(rotated.credential, 'server')).toEqual({ ...record, hash: expect.any(String) });
  expect(store.rotate(credential, 'server')).toBeUndefined();
  expect(readFileSync(file, 'utf8')).not.toContain(rotated.credential);
  expect(store.revoke(record.id)).toBe(true);
  expect(new NativePairings(file).verify(rotated.credential, 'server')).toBeUndefined();
  expect(store.verify(credential, 'server')).toBeUndefined();
});
it('revoke kills every credential bound to a device, without affecting other pairings', () => {
  const { store, file } = setup();
  const first = store.issue(grant, 'server');
  const second = store.issue({ ...grant, interactions: 'answer' }, 'server');
  const other = store.issue(grant, 'server');
  store.bind(first.credential, 'server', 'phone', 'fingerprint');
  store.bind(second.credential, 'server', 'phone', 'fingerprint');
  expect(store.revoke('phone')).toBe(true);
  expect(store.revoke('phone')).toBe(false);
  const reopened = new NativePairings(file);
  expect(reopened.verify(first.credential, 'server')).toBeUndefined();
  expect(reopened.verify(second.credential, 'server')).toBeUndefined();
  expect(reopened.verify(other.credential, 'server')).toMatchObject(grant);
  expect(store.bind(first.credential, 'server', 'phone', 'fingerprint')).toBe(false);
});
it('expires absolutely and refuses unsupported principals instead of promoting them', () => {
  const { store, file } = setup();
  const paired = store.issue(grant, 'server');
  vi.useFakeTimers();
  vi.setSystemTime(paired.record.expiresAt);
  expect(store.verify(paired.credential, 'server')).toBeUndefined();
  expect(store.rotate(paired.credential, 'server')).toBeUndefined();
  expect(() =>
    store.issue({ principal: { kind: 'device' }, interactions: 'answer' } as unknown as NativeGrant, 'server'),
  ).toThrow('Unsupported');
  writeFileSync(
    file,
    JSON.stringify([{ ...paired.record, principal: { kind: 'agent' }, expiresAt: Date.now() + 1000 }]),
  );
  expect(store.verify(paired.credential, 'server')).toBeUndefined();
});
