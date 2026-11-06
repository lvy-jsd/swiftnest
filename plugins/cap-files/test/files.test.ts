import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@swiftnest/core';
import { describe, expect, it } from 'vitest';
import { filesCapability } from '../src/index.js';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'sn-files-'));
  const root = join(base, 'shared');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(join(root, 'keys'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'a.txt'), 'hello');
  await writeFile(join(outside, 'secret.txt'), 'nope');
  await writeFile(join(root, 'keys', 'id'), 'private');
  await symlink(outside, join(root, 'escape'));
  const cap = filesCapability({ roots: [root], deny: [join(root, 'keys')] });
  const ctx = { taskId: 't', signal: new AbortController().signal, logger: silentLogger };
  const call = (tool: string, args: Record<string, unknown>) => cap.invoke(tool, args, ctx);
  return { root, outside, cap, call };
}

const text = (out: unknown) => (typeof out === 'string' ? out : (out as { text: string }).text);

describe('cap-files', () => {
  it('lists, reads, writes, moves and deletes inside the shared folder', async () => {
    const { root, call } = await setup();
    expect(text(await call('list', { path: root }))).toContain('a.txt');
    const read = (await call('read', { path: 'a.txt' })) as { text: string; untrusted: boolean };
    expect(read).toMatchObject({ text: 'hello', untrusted: true });
    await call('write', { path: 'sub/new.txt', content: 'x' });
    await call('write', { path: 'sub/new.txt', content: 'y', append: true });
    expect(await readFile(join(root, 'sub/new.txt'), 'utf8')).toBe('xy');
    await call('move', { from: 'sub/new.txt', to: 'sub/moved.txt' });
    await expect(call('move', { from: 'a.txt', to: 'sub/moved.txt' })).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    await expect(call('delete', { path: 'sub' })).rejects.toMatchObject({ code: 'IS_A_FOLDER' });
    await call('delete', { path: 'sub', recursive: true });
    await expect(call('stat', { path: 'sub' })).rejects.toBeTruthy();
    await expect(call('delete', { path: root, recursive: true })).rejects.toMatchObject({ code: 'PATH_REFUSED' });
  });

  it('refuses paths outside the shared folder, through a symlink too, and protected locations', async () => {
    const { outside, call } = await setup();
    await expect(call('read', { path: join(outside, 'secret.txt') })).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    await expect(call('read', { path: 'escape/secret.txt' })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(call('write', { path: 'escape/planted.txt', content: 'x' })).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    await expect(call('read', { path: 'keys/id' })).rejects.toMatchObject({ code: 'PATH_REFUSED' });
    await expect(call('read', { path: '../outside/secret.txt' })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });

  it('classifies by tool and by where the path points', async () => {
    const { outside, cap } = await setup();
    expect(cap.classify!('read', { path: 'a.txt' })?.risk).toBe('read');
    expect(cap.classify!('write', { path: 'a.txt' })?.risk).toBe('write');
    expect(cap.classify!('delete', { path: 'a.txt' })?.risk).toBe('sensitive');
    expect(cap.classify!('read', { path: join(outside, 'x') })?.risk).toBe('sensitive');
    expect(cap.classify!('move', { from: 'a.txt', to: join(outside, 'x') })?.risk).toBe('sensitive');
    expect(cap.classify!('read', { path: '~/.ssh/id_ed25519' })?.risk).toBe('sensitive');
  });

  it('marks a path it would refuse as refused, so the owner is never asked to approve it', async () => {
    const { outside, cap } = await setup();
    // A usable path is only a rating: the policy still decides.
    expect(cap.classify!('read', { path: 'a.txt' })).toEqual({ risk: 'read' });
    // These cannot succeed, whatever the owner answers.
    expect(cap.classify!('read', { path: join(outside, 'secret.txt') })).toMatchObject({
      risk: 'sensitive',
      refused: true,
    });
    expect(cap.classify!('read', { path: 'keys/id' })).toMatchObject({ risk: 'sensitive', refused: true });
    expect(cap.classify!('move', { from: 'a.txt', to: join(outside, 'x') })).toMatchObject({ refused: true });
    expect(cap.classify!('delete', { path: '../outside/secret.txt' })).toMatchObject({ refused: true });
  });

  it('names the real problem when the filesystem says no', async () => {
    const { call } = await setup();
    // A missing file used to surface as a raw errno string with "check the connection and settings".
    await expect(call('stat', { path: 'nope.txt' })).rejects.toMatchObject({
      code: 'PATH_MISSING',
      message: 'nope.txt does not exist.',
      suggestion: 'List the folder on the device to see what is there.',
    });
    await expect(call('read', { path: 'nope/missing.txt' })).rejects.toMatchObject({ code: 'PATH_MISSING' });
    // Writing over a folder: EISDIR, said in words instead of errno 21.
    await expect(call('write', { path: 'sub', content: 'x' })).rejects.toMatchObject({
      code: 'NOT_A_FILE',
      message: 'sub is a folder.',
    });
    // Reading a folder is refused before an OS error can happen.
    await expect(call('read', { path: 'sub' })).rejects.toMatchObject({ code: 'NOT_A_FILE' });
  });
});
