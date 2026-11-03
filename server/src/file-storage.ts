import { text } from '@swiftnest/core';
import { ServerFailure } from './i18n.js';
/** Server is an endpoint only for its own files. Device ↔ device relays never call this codec. */
import { createHash, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { mkdir, open, stat, lstat, readFile, rename, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PathGuard, type BinaryPeer, type FileBinding, type FileStreamOptions, type Capability } from '@swiftnest/core';

export const CHUNK = 4 * 1024 * 1024;
export const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
export const transferId = (b: FileBinding) =>
  digest(
    JSON.stringify([
      'swiftnest/file/v1',
      b.source,
      b.destination,
      b.sourcePath,
      b.destinationPath,
      b.meta.size,
      b.meta.mtime,
      b.meta.prefix,
    ]),
  );
export interface Journal {
  binding: FileBinding;
  offset: number;
  state: string;
  hash: string | null;
  route: string;
}
/** Regular-file I/O may legally be short; never ACK bytes that were not written. */
export async function writeFully(file: FileHandle, data: Buffer, position: number) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, position + offset);
    if (!bytesWritten) throw new ServerFailure(text('fileWriteMadeNoProgress'));
    offset += bytesWritten;
  }
}
export async function readFully(file: FileHandle, data: Buffer, length: number, position: number) {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(data, offset, length - offset, position + offset);
    if (!bytesRead) throw new ServerFailure(text('sourceTruncated'));
    offset += bytesRead;
  }
}
export async function atomicJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const file = await open(tmp, 'w', 0o600);
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  if (process.platform !== 'win32') {
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}
export async function inspectFile(path: string): Promise<FileBinding['meta']> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ServerFailure(text('sourceMustRegularFile'));
    const buffer = Buffer.alloc(Math.min(1024 * 1024, info.size));
    await readFully(file, buffer, buffer.length, 0);
    return {
      size: info.size,
      mtime: Math.trunc(info.mtimeMs),
      prefix: digest(buffer),
    };
  } finally {
    await file.close();
  }
}
export class FileStorage {
  private guard: PathGuard;
  private serial = Promise.resolve();
  constructor(
    readonly root: string,
    readonly state: string,
    readonly identity: string,
    readonly quota: number,
  ) {
    this.guard = new PathGuard({ roots: [root] });
    // config.home/files is an explicitly owned storage endpoint, even when SWIFTNEST_HOME is protected.
    for (let i = this.guard.secrets.length - 1; i >= 0; i--)
      if (this.guard.secrets[i] === dirname(root)) this.guard.secrets.splice(i, 1);
  }
  async allowed(raw: string) {
    const c = await this.guard.check(raw);
    if (!c.inside || c.secret || basename(c.real).startsWith('.swiftnest-'))
      throw new ServerFailure(text('protectedUnsharedServerPath'));
    // Refuse dangling links too (the shared TS guard predates the native check).
    if ((await lstat(c.path).catch(() => undefined))?.isSymbolicLink() && !(await stat(c.path).catch(() => undefined)))
      throw new ServerFailure(text('danglingSymlink'));
    return c.real;
  }
  journal(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ServerFailure(text('invalidTransferId'));
    return join(this.state, `${id}.json`);
  }
  async load(id: string): Promise<Journal> {
    return JSON.parse(await readFile(this.journal(id), 'utf8'));
  }
  async save(j: Journal) {
    await atomicJson(this.journal(transferId(j.binding)), j);
  }
  async part(b: FileBinding) {
    const target = await this.allowed(b.destinationPath);
    return join(dirname(target), `.swiftnest-${transferId(b)}.part`);
  }
  async prepare(b: FileBinding): Promise<Journal> {
    // Serialize quota reservations, including two simultaneous approvals.
    let resolve!: () => void;
    const previous = this.serial;
    this.serial = new Promise<void>((r) => (resolve = r));
    await previous;
    try {
      if (b.destination !== this.identity || !Number.isSafeInteger(b.meta.size) || b.meta.size < 0)
        throw new ServerFailure(text('invalidDestinationIdentitySize'));
      const old = await this.load(transferId(b)).catch(() => undefined);
      if (old) return old;
      const target = await this.allowed(b.destinationPath);
      if (await lstat(target).catch(() => undefined))
        throw new ServerFailure(text('destinationExistsChooseAnotherName'));
      let used = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) await walk(p);
          else if (entry.isFile()) used += (await stat(p)).size;
        }
      };
      await walk(this.root);
      for (const entry of await readdir(this.state).catch(() => [])) {
        if (!entry.endsWith('.json')) continue;
        const j = await this.load(entry.slice(0, -5));
        if (j.state !== 'complete') {
          const actual = (await stat(await this.part(j.binding)).catch(() => undefined))?.size ?? 0;
          used += Math.max(0, j.binding.meta.size - actual);
        }
      }
      if (used + b.meta.size > this.quota) throw new ServerFailure(text('serverFilesQuotaExceeded'));
      const temp = await open(await this.part(b), 'wx', 0o600);
      await temp.sync();
      await temp.close();
      const j: Journal = {
        binding: b,
        offset: 0,
        state: 'ready',
        hash: null,
        route: 'relay',
      };
      await this.save(j);
      return j;
    } finally {
      resolve();
    }
  }
  capability(): Capability {
    return {
      manifest: {
        id: 'transfer',
        version: '0.0.1',
        title: 'Server files',
        description: 'Server storage endpoint',
        permissions: ['files.read', 'files.write'],
        tools: ['inspect', 'receive', 'status'].map((name) => ({
          name,
          description: `File transfer ${name}`,
          risk: name === 'receive' ? ('write' as const) : ('read' as const),
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      },
      classify: (tool, args) => ({
        risk: tool === 'receive' ? 'write' : 'read',
        reason: `File transfer ${tool}: ${JSON.stringify(args)}`,
      }),
      invoke: async (tool, args) => ({
        text: 'File transfer',
        data:
          tool === 'inspect'
            ? await inspectFile(await this.allowed(String(args.path)))
            : tool === 'receive'
              ? await this.prepare(args.binding as FileBinding)
              : await this.load(String(args.id)),
      }),
    };
  }
}
/** Same stream-v1 AEAD envelope and HKDF domain as Rust; fresh cipherId/key on EVERY attempt. */
export class FileCipher {
  private sent = 0n;
  private received = 0n;
  private id: Buffer;
  private sendKey: Buffer;
  private receiveKey: Buffer;
  constructor(file: FileStreamOptions, sender: boolean) {
    this.id = Buffer.from(file.cipherId, 'hex');
    const keys = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(file.key, 'base64url'),
        Buffer.alloc(32),
        `swiftnest/stream/v1/${file.cipherId}`,
        64,
      ),
    );
    this.sendKey = keys.subarray(sender ? 0 : 32, sender ? 32 : 64);
    this.receiveKey = keys.subarray(sender ? 32 : 0, sender ? 64 : 32);
  }
  seal(flag: number, data: Uint8Array) {
    if (data.length > CHUNK || this.sent === 0xffffffffffffffffn) throw new ServerFailure(text('fileRecordLimit'));
    const header = Buffer.alloc(30);
    header[0] = 1;
    this.id.copy(header, 1);
    header.writeBigUInt64BE(this.sent++, 17);
    header[25] = flag;
    header.writeUInt32BE(data.length, 26);
    const nonce = Buffer.alloc(12);
    header.copy(nonce, 4, 17, 25);
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonce);
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  }
  open(raw: Uint8Array): [number, Buffer] {
    const b = Buffer.from(raw);
    if (
      b.length < 46 ||
      b.length > CHUNK + 46 ||
      b[0] !== 1 ||
      !b.subarray(1, 17).equals(this.id) ||
      b.readBigUInt64BE(17) !== this.received ||
      b.readUInt32BE(26) !== b.length - 46
    )
      throw new ServerFailure(text('invalidFileRecordReplay'));
    const nonce = Buffer.alloc(12);
    b.copy(nonce, 4, 17, 25);
    const cipher = createDecipheriv('aes-256-gcm', this.receiveKey, nonce);
    cipher.setAAD(b.subarray(0, 30));
    cipher.setAuthTag(b.subarray(-16));
    const plain = Buffer.concat([cipher.update(b.subarray(30, -16)), cipher.final()]);
    this.received++;
    return [b[25]!, plain];
  }
}
/** Bounded pull inbox; one chunk + control header. An abusive sender is disconnected. */
export function fileInbox(cipher: FileCipher, signal: AbortSignal) {
  const queue: [number, Buffer][] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let failure: unknown;
  const peer: BinaryPeer = {
    bufferedAmount: 0,
    send(data) {
      try {
        if (queue.length >= 2) throw new ServerFailure(text('fileBackpressure'));
        queue.push(cipher.open(data));
        wake?.();
      } catch (e) {
        failure = e;
        closed = true;
        wake?.();
      }
    },
    onData(fn) {
      out = fn;
    },
    onEnd(fn) {
      ended = fn;
    },
    close() {
      closed = true;
      wake?.();
      ended?.();
    },
  };
  let out: ((data: Uint8Array) => void) | undefined;
  let ended: (() => void) | undefined;
  const abort = () => {
    failure = signal.reason;
    peer.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  return {
    peer,
    check: () => signal.throwIfAborted(),
    async get(): Promise<[number, Buffer]> {
      while (!queue.length) {
        if (closed || signal.aborted) throw failure ?? new ServerFailure(text('fileStreamClosed'));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            wake = undefined;
            reject(new ServerFailure(text('fileStreamTimeout')));
          }, 1800000);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      }
      return queue.shift()!;
    },
    put(flag: number, data: Uint8Array) {
      signal.throwIfAborted();
      if (closed || !out) throw new ServerFailure(text('fileStreamClosed'));
      out(cipher.seal(flag, data));
    },
    close() {
      signal.removeEventListener('abort', abort);
      peer.close();
    },
  };
}
async function prefix(file: FileHandle, size: number, check = () => {}) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(256 * 1024);
  let offset = 0;
  while (offset < size) {
    check();
    const { bytesRead } = await file.read(buf, 0, Math.min(buf.length, size - offset), offset);
    if (!bytesRead) throw new ServerFailure(text('fileTruncated'));
    hash.update(buf.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash;
}
export async function storageEndpoint(
  storage: FileStorage,
  offer: FileStreamOptions,
  inbox: ReturnType<typeof fileInbox>,
  progress: (j: Journal) => void,
) {
  const b = offer.binding;
  const send = (v: unknown) => inbox.put(4, Buffer.from(JSON.stringify(v)));
  const control = async () => {
    const [flag, data] = await inbox.get();
    if (flag !== 4 || data.length > 8192) throw new ServerFailure(text('expectedFileControl'));
    return JSON.parse(data.toString());
  };
  if (offer.sender) {
    const path = await storage.allowed(b.sourcePath);
    if (JSON.stringify(await inspectFile(path)) !== JSON.stringify(b.meta))
      throw new ServerFailure(text('sourceChanged'));
    const input = await open(path, 'r');
    try {
      const ready = await control();
      if (ready.type === 'complete') return;
      let offset = ready.offset as number;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > b.meta.size ||
        (offset !== b.meta.size && offset % CHUNK)
      )
        throw new ServerFailure(text('badResumeOffset'));
      const hash = await prefix(input, offset, inbox.check);
      if (ready.prefix !== hash.copy().digest('hex')) {
        send({ type: 'reset' });
        throw new ServerFailure(text('partialFileHashChanged'));
      }
      const buffer = Buffer.alloc(CHUNK);
      while (offset < b.meta.size) {
        const length = Math.min(CHUNK, b.meta.size - offset);
        inbox.check();
        await readFully(input, buffer, length, offset);
        let accepted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          send({
            type: 'chunk',
            offset,
            length,
            hash: digest(buffer.subarray(0, length)),
          });
          inbox.put(5, buffer.subarray(0, length));
          const ack = await control();
          if (ack.type === 'ack' && ack.offset === offset + length) {
            accepted = true;
            break;
          }
          if (ack.type !== 'retry' || ack.offset !== offset) throw new ServerFailure(text('badAck'));
        }
        if (!accepted) throw new ServerFailure(text('repeatedBadChunk'));
        hash.update(buffer.subarray(0, length));
        offset += length;
      }
      if (JSON.stringify(await inspectFile(path)) !== JSON.stringify(b.meta))
        throw new ServerFailure(text('sourceChanged'));
      send({ type: 'finish', hash: hash.digest('hex') });
      if ((await control()).type !== 'complete') throw new ServerFailure(text('finalVerificationFailed'));
    } finally {
      await input.close();
    }
  } else {
    const j = await storage.load(transferId(b));
    if (JSON.stringify(j.binding) !== JSON.stringify(b)) throw new ServerFailure(text('unapprovedTransfer'));
    if (j.state === 'complete') {
      send({ type: 'complete', hash: j.hash });
      progress(j);
      return;
    }
    const part = await storage.part(b);
    if (j.state === 'committing' && !(await lstat(part).catch(() => undefined))) {
      const target = await open(await storage.allowed(b.destinationPath), 'r');
      try {
        if ((await prefix(target, b.meta.size)).digest('hex') !== j.hash)
          throw new ServerFailure(text('committedFileChanged'));
      } finally {
        await target.close();
      }
      j.state = 'complete';
      await storage.save(j);
      progress(j);
      send({ type: 'complete', hash: j.hash });
      return;
    }
    if ((await lstat(part)).isSymbolicLink()) throw new ServerFailure(text('temporaryFileSymlink'));
    const output = await open(part, 'r+');
    try {
      if ((await output.stat()).size < j.offset) j.offset = 0;
      await output.truncate(j.offset);
      const hash = await prefix(output, j.offset, inbox.check);
      j.state = 'running';
      await storage.save(j);
      progress(j);
      send({
        type: 'ready',
        offset: j.offset,
        prefix: hash.copy().digest('hex'),
      });
      while (true) {
        const msg = await control();
        if (msg.type === 'reset') {
          j.offset = 0;
          j.state = 'ready';
          await output.truncate(0);
          await output.sync();
          await storage.save(j);
          throw new ServerFailure(text('resumePrefixReset'));
        }
        if (msg.type === 'finish') {
          if (j.offset !== b.meta.size || msg.hash !== hash.copy().digest('hex')) {
            j.offset = 0;
            j.state = 'ready';
            await storage.save(j);
            throw new ServerFailure(text('wholeFileHashMismatch'));
          }
          await output.sync();
          const target = await storage.allowed(b.destinationPath);
          if (await lstat(target).catch(() => undefined)) throw new ServerFailure(text('destinationExists'));
          j.state = 'committing';
          j.hash = msg.hash;
          await storage.save(j);
          await rename(part, target);
          j.state = 'complete';
          await storage.save(j);
          progress(j);
          send({ type: 'complete', hash: j.hash });
          return;
        }
        const length = Math.min(CHUNK, b.meta.size - j.offset);
        if (msg.type !== 'chunk' || msg.offset !== j.offset || msg.length !== length || !length)
          throw new ServerFailure(text('badChunk'));
        const [flag, data] = await inbox.get();
        if (flag !== 5 || data.length !== length || msg.hash !== digest(data)) {
          send({ type: 'retry', offset: j.offset });
          continue;
        }
        inbox.check();
        await writeFully(output, data, j.offset);
        await output.datasync();
        hash.update(data);
        j.offset += length;
        await storage.save(j);
        progress(j);
        send({ type: 'ack', offset: j.offset });
      }
    } finally {
      await output.close();
    }
  }
}
