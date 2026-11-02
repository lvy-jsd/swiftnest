import { createCipheriv, hkdfSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { StreamRegistry, type BinaryPeer } from '../src/streams.js';
import type { SecureChannel } from '../src/channel.js';
import { LiveView } from '../../api/src/live.js';
import { inputManifest } from '../src/input-manifest.js';
import { screenManifest } from '../src/screen-manifest.js';
import { readFile } from 'node:fs/promises';

function parent() {
  const messages: any[] = [];
  const p = {
    streamRoot: Buffer.alloc(32, 1),
    transcriptHash: Buffer.alloc(32, 2),
    send: (m: unknown) => messages.push(m),
  } as unknown as SecureChannel;
  return { p, messages };
}
function peer() {
  let data: (b: Uint8Array) => void = () => {};
  let end: () => void = () => {};
  let closed = false;
  let buffered = 0;
  const sent: Uint8Array[] = [];
  const p: BinaryPeer = {
    get bufferedAmount() {
      return buffered;
    },
    send: (b) => sent.push(b),
    onData: (fn) => {
      data = fn;
    },
    onEnd: (fn) => {
      end = fn;
    },
    close: () => {
      closed = true;
    },
  };
  return {
    p,
    sent,
    write: (b: Uint8Array) => data(b),
    end: () => end(),
    get closed() {
      return closed;
    },
    slow: () => {
      buffered = 99999999;
    },
  };
}
it('native screen/input manifest parity and all input tools request exec risk', async () => {
  for (const manifest of [screenManifest, inputManifest])
    expect(
      JSON.parse(
        await readFile(new URL(`../../../native/perch/src/manifests/${manifest.id}.json`, import.meta.url), 'utf8'),
      ),
    ).toEqual(manifest);
  expect(inputManifest.tools.every((t) => t.risk === 'exec')).toBe(true);
});
it('separates directional keys, binds one-use tickets to parent, bounds relay and closes on parent loss', async () => {
  const r = new StreamRegistry();
  const { p, messages } = parent();
  const opening = r.open(p, { maxDimension: 640, displayId: '' });
  const id = messages[0].id;
  expect(messages[0]).not.toHaveProperty('sendKey');
  r.accept(id, { ...p } as SecureChannel); // another session cannot accept
  r.accept(id, p);
  const offer = await opening;
  const keys = Buffer.from(hkdfSync('sha256', p.streamRoot, p.transcriptHash, `swiftnest/stream/v1/${id}`, 64));
  expect(Buffer.from(offer.receiveKey, 'base64url')).toEqual(keys.subarray(0, 32));
  expect(offer.sendKey).not.toBe(offer.receiveKey);
  const invalid = peer();
  expect(r.attachDevice(id, 'wrong', invalid.p)).toBe(false);
  expect(invalid.closed).toBe(true);
  const device = peer(),
    owner = peer();
  expect(r.attachDevice(id, offer.ticket, device.p)).toBe(true);
  expect(r.attachDevice(id, offer.ticket, peer().p)).toBe(false);
  expect(r.attachOwner(id, owner.p)).toBe(true);
  const record = new Uint8Array(64);
  owner.write(record);
  expect(device.sent).toEqual([record]);
  device.write(record);
  expect(owner.sent).toEqual([record]);
  owner.slow();
  device.write(record);
  expect(device.closed && owner.closed).toBe(true);
  const next = r.open(p, { maxDimension: 640, displayId: '' });
  r.accept(messages.at(-1).id, p);
  await next;
  r.closeParent(p);
  expect(r.attachOwner(messages.at(-2).id, peer().p)).toBe(false);
  r.closeAll();
});
it('queues at most one bounded owner authentication during device dial and rejects duplicate viewers', async () => {
  const r = new StreamRegistry();
  const { p, messages } = parent();
  const opening = r.open(p, { maxDimension: 640, displayId: '' });
  r.accept(messages[0].id, p);
  const offer = await opening;
  const owner = peer();
  r.attachOwner(offer.id, owner.p);
  owner.write(new Uint8Array(64));
  const device = peer();
  r.attachDevice(offer.id, offer.ticket, device.p);
  expect(device.sent[0]).toHaveLength(64);
  expect(r.attachOwner(offer.id, peer().p)).toBe(false);
  await expect(r.open(p, { maxDimension: 640, displayId: '' })).rejects.toThrow('already');
  r.closeParent(p);
  expect(device.closed && owner.closed).toBe(true);
});
it('API authenticates binary stream records, serializes owner input, and pauses on replay', async () => {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const sent: Uint8Array[] = [];
  const socket = {
    readyState: 1,
    send: (v: string | Uint8Array) => {
      sent.push(v as Uint8Array);
    },
    close: () => {},
    addEventListener: (t: string, fn: (e: any) => void) => {
      const s = listeners.get(t) ?? new Set();
      s.add(fn);
      listeners.set(t, s);
    },
    removeEventListener: (t: string, fn: (e: any) => void) => {
      listeners.get(t)?.delete(fn);
    },
  };
  const offer = {
    id: '0123456789abcdef0123456789abcdef',
    sendKey: Buffer.alloc(32, 1).toString('base64url'),
    receiveKey: Buffer.alloc(32, 2).toString('base64url'),
    maxFrame: 4194304,
    maxDimension: 640,
    displayId: 'a',
  };
  const live = await LiveView.open(socket, offer);
  expect(sent[0]!.length).toBeGreaterThan(46);
  await expect(live.input('input_click', {})).rejects.toThrow('Take over');
  const state = Buffer.from(JSON.stringify({ control: 'owner' }));
  const h = Buffer.alloc(30);
  h[0] = 1;
  Buffer.from(offer.id, 'hex').copy(h, 1);
  h[25] = 3;
  h.writeUInt32BE(state.length, 26);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), Buffer.alloc(12));
  cipher.setAAD(h);
  const record = Buffer.concat([h, cipher.update(state), cipher.final(), cipher.getAuthTag()]);
  const emit = (b: Buffer) => {
    for (const fn of listeners.get('message') ?? []) fn({ data: b });
  };
  emit(record);
  expect((await live.next()).value?.control).toBe('owner');
  await Promise.all([live.input('input_key', { key: 'ctrl+c' }), live.handBack()]);
  expect(sent.map((f) => new DataView(f.buffer, f.byteOffset).getBigUint64(17))).toEqual([0n, 1n, 2n]);
  emit(record);
  expect((await live.next()).value?.control).toBe('paused');
  expect((await live.next()).done).toBe(true);
  live.close();
});
