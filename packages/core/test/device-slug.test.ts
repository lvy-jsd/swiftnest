import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { deviceSlug, JsonDeviceStore, MemoryDeviceStore } from '../src/pairing.js';

it('normalizes names, bounds slugs, handles non-Latin names and resolves collisions', () => {
  expect(deviceSlug('My Laptop_1')).toBe('my-laptop_1');
  expect(deviceSlug('ÉliteBook')).toBe('e-litebook');
  expect(deviceSlug('手机')).toBe('device');
  expect(deviceSlug('laptop', ['laptop', 'laptop-2'])).toBe('laptop-3');
  const name = 'a'.repeat(40);
  expect(deviceSlug(name)).toHaveLength(24);
  expect(deviceSlug(name, ['a'.repeat(24)])).toBe(`${'a'.repeat(22)}-2`);
  for (const value of ['', '__', '123', '测试 - phone !', name])
    expect(deviceSlug(value)).toMatch(/^[a-z0-9_-]{1,24}$/);
});

it('assigns unique slugs at pairing and preserves them when the display name changes', async () => {
  const store = new MemoryDeviceStore();
  await store.add({ device: 'one', name: 'Laptop', publicKey: 'key1', pairedAt: 'now' });
  await store.add({ device: 'two', name: 'Laptop', publicKey: 'key2', pairedAt: 'now' });
  expect(store.list().map((d) => d.slug)).toEqual(['laptop', 'laptop-2']);
  await store.add({ ...store.get('one')!, name: 'Renamed', slug: 'ignored' });
  expect(store.get('one')).toMatchObject({ slug: 'laptop', name: 'Renamed', kind: 'desktop' });
  const copy = store.get('one')!;
  copy.slug = 'mutated';
  expect(store.get('one')?.slug).toBe('laptop');
});

it('atomically migrates existing records, reserving existing slugs, and persists them across reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swiftnest-slugs-'));
  try {
    const path = join(dir, 'paired.json');
    await writeFile(
      path,
      JSON.stringify({
        devices: [
          { device: 'Laptop', publicKey: 'key1', pairedAt: 'then' },
          { device: 'phone', slug: 'laptop', name: 'Phone', kind: 'android', publicKey: 'key2', pairedAt: 'then' },
          { device: 'duplicate', slug: 'laptop', publicKey: 'key3', pairedAt: 'then' },
        ],
      }),
    );
    const store = await JsonDeviceStore.open(path);
    expect(store.list().map((d) => d.slug)).toEqual(['laptop-2', 'laptop', 'duplicate']);
    expect(store.get('phone')).toMatchObject({ slug: 'laptop', kind: 'android' });
    const saved = await readFile(path, 'utf8');
    expect((await JsonDeviceStore.open(path)).list()).toEqual(store.list());
    expect(await readFile(path, 'utf8')).toBe(saved);
    await store.add({ ...store.get('phone')!, name: 'New Phone' });
    expect((await JsonDeviceStore.open(path)).get('phone')).toMatchObject({ name: 'New Phone', slug: 'laptop' });
    await Promise.all(
      [1, 2, 3].map((n) => store.add({ device: `new-${n}`, name: 'Same', publicKey: `key-${n}`, pairedAt: 'now' })),
    );
    expect(
      (await JsonDeviceStore.open(path))
        .list()
        .slice(-3)
        .map((d) => d.slug),
    ).toEqual(['same', 'same-2', 'same-3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
