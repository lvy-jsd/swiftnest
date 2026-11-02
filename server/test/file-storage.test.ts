import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  FileStorage,
  FileCipher,
  fileInbox,
  storageEndpoint,
  inspectFile,
  transferId,
  digest,
  writeFully,
  readFully,
} from '../src/file-storage.js';
import type { FileBinding, FileStreamOptions } from '@swiftnest/core';

it('server quota reservations survive restart and reject identity, protected paths and symlink escapes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'file-quota-'));
  try {
    await mkdir(join(home, 'files'));
    await mkdir(join(home, 'outside'));
    const store = new FileStorage(join(home, 'files'), join(home, 'receipts'), 'server', 20);
    const binding: FileBinding = {
      source: 'source',
      destination: 'server',
      sourcePath: 'source.bin',
      destinationPath: 'video.bin',
      meta: { size: 15, mtime: 1, prefix: digest('video') },
    };
    const competing = await Promise.allSettled([
      store.prepare(binding),
      store.prepare({ ...binding, destinationPath: 'other.bin' }),
    ]);
    expect(competing.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const reopened = new FileStorage(store.root, store.state, 'server', 20);
    expect((await reopened.prepare(binding)).offset).toBe(0);
    await expect(reopened.prepare({ ...binding, destinationPath: 'other.bin' })).rejects.toThrow('quota');
    await expect(reopened.prepare({ ...binding, destination: 'attacker' })).rejects.toThrow('identity');
    await expect(reopened.allowed('../outside/x')).rejects.toThrow('Protected');
    await symlink(join(home, 'outside'), join(home, 'files', 'escape'));
    await expect(reopened.allowed('escape/x')).rejects.toThrow('Protected');
    await symlink(join(home, 'missing'), join(home, 'files', 'dangling'));
    await expect(reopened.allowed('dangling')).rejects.toThrow();
    expect(transferId({ ...binding, meta: { ...binding.meta, mtime: 2 } })).not.toBe(transferId(binding));
    expect(transferId({ ...binding, destination: 'different' })).not.toBe(transferId(binding));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it('binary file endpoints transfer empty and partial chunks, authenticate records and publish only verified bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'file-endpoints-'));
  try {
    for (const length of [0, 4096, 4 * 1024 * 1024 + 7]) {
      const from = join(home, `from${length}`),
        to = join(home, `to${length}`);
      await mkdir(from);
      await mkdir(to);
      const path = join(from, 'input');
      await writeFile(path, Buffer.alloc(length, 0xa9));
      const source = new FileStorage(from, `${from}-state`, 'a', 10 ** 8),
        destination = new FileStorage(to, `${to}-state`, 'b', 10 ** 8);
      const binding: FileBinding = {
        source: 'a',
        destination: 'b',
        sourcePath: path,
        destinationPath: join(to, 'output'),
        meta: await inspectFile(path),
      };
      await destination.prepare(binding);
      const offer: FileStreamOptions = {
        binding,
        sender: true,
        key: Buffer.alloc(32, 1).toString('base64url'),
        cipherId: 'ab'.repeat(16),
        directTicket: 'test',
        listen: false,
        candidates: [],
      };
      const stop = new AbortController();
      const sender = fileInbox(new FileCipher(offer, true), stop.signal),
        receiver = fileInbox(new FileCipher(offer, false), stop.signal);
      sender.peer.onData((data) => receiver.peer.send(data));
      receiver.peer.onData((data) => sender.peer.send(data));
      try {
        await Promise.all([
          storageEndpoint(source, offer, sender, () => {}),
          storageEndpoint(destination, { ...offer, sender: false }, receiver, () => {}),
        ]);
      } finally {
        sender.close();
        receiver.close();
      }
      expect(await readFile(binding.destinationPath)).toEqual(await readFile(path));
      expect((await destination.load(transferId(binding))).state).toBe('complete');
      const a = new FileCipher(offer, true),
        b = new FileCipher(offer, false);
      const frame = a.seal(5, Buffer.from('secret'));
      expect(frame.includes(Buffer.from('secret'))).toBe(false);
      expect(b.open(frame)[1].toString()).toBe('secret');
      expect(() => b.open(frame)).toThrow('replay');
      const tampered = a.seal(5, Buffer.from('secret'));
      tampered[tampered.length - 1]! ^= 1;
      expect(() => b.open(tampered)).toThrow();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('short OS reads/writes cannot silently truncate an acknowledged chunk', async () => {
  const data = Buffer.from('a complete authenticated chunk'),
    disk = Buffer.alloc(data.length);
  const file = {
    async write(buffer: Buffer, offset: number, length: number, position: number) {
      const bytesWritten = Math.min(3, length);
      buffer.copy(disk, position, offset, offset + bytesWritten);
      return { bytesWritten };
    },
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      const bytesRead = Math.min(2, length, disk.length - position);
      disk.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
  } as unknown as import('node:fs/promises').FileHandle;
  await writeFully(file, data, 0);
  const read = Buffer.alloc(data.length);
  await readFully(file, read, read.length, 0);
  expect(read).toEqual(data);
  const stalled = {
    write: async () => ({ bytesWritten: 0 }),
    read: async () => ({ bytesRead: 0 }),
  } as unknown as import('node:fs/promises').FileHandle;
  await expect(writeFully(stalled, data, 0)).rejects.toThrow('no progress');
  await expect(readFully(stalled, read, read.length, 0)).rejects.toThrow('truncated');
});
