import { mkdir, open, readFile, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { channelPublicKey, generateChannelIdentity, type ChannelIdentity } from '@swiftnest/channel';

/** Refuse malformed/symlinked identities; never silently replace a paired server's key. */
export async function loadChannelIdentity(home: string): Promise<ChannelIdentity> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'app-channel-key.json');
  try {
    const identity = await generateChannelIdentity();
    const fd = await open(file, 'wx', 0o600);
    try {
      await fd.writeFile(JSON.stringify(identity));
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot create channel identity');
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid channel identity file');
  await chmod(file, 0o600);
  try {
    const identity = JSON.parse(await readFile(file, 'utf8')) as ChannelIdentity;
    channelPublicKey(identity);
    return identity;
  } catch {
    throw new Error('Cannot read channel identity');
  }
}
