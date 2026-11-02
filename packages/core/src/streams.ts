/** Bulk transport is deliberately independent of the JSON channel. The Nest relays opaque AEAD records. */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SecureChannel } from './channel.js';

export const STREAM_MAX = 4 * 1024 * 1024;
export interface BinaryPeer {
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  onData(fn: (data: Uint8Array) => void): void;
  onEnd(fn: () => void): void;
  close(): void;
}
export interface FileBinding {
  source: string; destination: string; sourcePath: string; destinationPath: string;
  meta: { size: number; mtime: number; prefix: string };
}
export interface FileStreamOptions {
  binding: FileBinding; sender: boolean; key: string; cipherId: string;
  candidates: string[]; directTicket: string; listen: boolean;
}
export interface StreamOffer {
  id: string; purpose: 'screen' | 'file'; direction: 'duplex'; transportCandidates: ['websocket-relay-v1']; ticket: string; expires: number;
  maxFrame: number; maxDimension: number; displayId: string;
  /** Owner endpoint credentials, returned only through the owner HTTP API. */
  sendKey: string; receiveKey: string;
  file?: FileStreamOptions;
  candidates?: string[];
}
interface Entry {
  offer: StreamOffer; parent: SecureChannel; accepted: boolean;
  device?: BinaryPeer; owner?: BinaryPeer; consumed: boolean; pending?: Uint8Array;
  timer: ReturnType<typeof setTimeout>; settle: (error?: Error) => void;
}
export class StreamRegistry {
  private entries = new Map<string, Entry>();
  async open(parent: SecureChannel, options: { maxDimension: number; displayId: string }, file?: FileStreamOptions): Promise<StreamOffer> {
    if (!Number.isInteger(options.maxDimension) || options.maxDimension < 320 || options.maxDimension > 2560 || options.displayId.length > 128) throw new Error('Invalid viewer limits');
    if (!file && [...this.entries.values()].some(e => e.parent === parent && e.offer.purpose === 'screen')) throw new Error('This device already has a viewer');
    if (this.entries.size >= 32) throw new Error('Too many streams');
    const id = randomBytes(16).toString('hex'), expires = Date.now() + 15000;
    const ticket = createHmac('sha256', parent.streamRoot).update(`swiftnest/ticket/v1\0${id}\0${expires}`).digest('base64url');
    const keys = Buffer.from(hkdfSync('sha256', parent.streamRoot, parent.transcriptHash, `swiftnest/stream/v1/${id}`, 64));
    const offer: StreamOffer = { id, purpose: file ? 'file' : 'screen', ...(file ? {file} : {}), direction:'duplex', transportCandidates:['websocket-relay-v1'], ticket, expires, maxFrame: STREAM_MAX, ...options, sendKey: keys.subarray(32).toString('base64url'), receiveKey: keys.subarray(0,32).toString('base64url') };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id, 'Stream negotiation expired'), 15000);
      this.entries.set(id, { offer, parent, accepted: false, consumed: false, timer, settle: error => error ? reject(error) : resolve() });
      const { sendKey: _send, receiveKey: _receive, ...wire } = offer;
      try { parent.send({ type: 'stream_open', ...wire }); } catch { this.finish(id, 'Device disconnected'); }
    });
    return offer;
  }
  accept(id: string, parent: SecureChannel, candidates?: string[]): void {
    const e = this.entries.get(id);
    if (e?.parent === parent && !e.accepted) { e.accepted = true;
      if (e.offer.file) { e.offer.candidates = (candidates ?? []).slice(0,3); clearTimeout(e.timer); e.timer=setTimeout(()=>this.finish(id,'File attempt expired'),24*60*60*1000); }
      e.settle(); }
  }
  attachDevice(id: string, ticket: string, peer: BinaryPeer): boolean {
    const e = this.entries.get(id), given = Buffer.from(ticket);
    if (!e || e.consumed || Date.now() > e.offer.expires || given.length !== e.offer.ticket.length || !timingSafeEqual(given, Buffer.from(e.offer.ticket))) { peer.close(); return false; }
    e.consumed = true; e.device = peer; this.wire(id, e, peer, 'owner'); if (e.pending) { peer.send(e.pending); e.pending=undefined; } return true;
  }
  /** Caller MUST admit an owner session before this method. There is no agent route to it. */
  attachOwner(id: string, peer: BinaryPeer): boolean {
    const e = this.entries.get(id);
    if (!e || e.owner || !e.accepted || (e.offer.purpose === 'screen' && Date.now() > e.offer.expires)) { peer.close(); return false; }
    e.owner = peer; this.wire(id, e, peer, 'device'); return true;
  }
  private wire(id: string, e: Entry, source: BinaryPeer, target: 'device' | 'owner') {
    source.onEnd(() => this.finish(id, 'Viewer disconnected'));
    source.onData(data => {
      const dest = e[target];
      if (!dest && target==='device' && !e.pending && data.length>=46 && data.length<=4096) { e.pending=new Uint8Array(data); return; }
      // Never drop already encrypted records: doing so would skip an AEAD counter.
      // Producers drop stale *plaintext* video before sealing. Slow relays close, with bounded memory.
      if (!dest || data.length < 46 || data.length > e.offer.maxFrame + 46 || (target === 'device' && e.offer.purpose === 'screen' && data.length > 65536) || dest.bufferedAmount > e.offer.maxFrame * 2) return this.finish(id, 'Stream backpressure or invalid record');
      dest.send(data);
    });
    if (e.owner && e.device) { clearTimeout(e.timer); e.timer = setTimeout(() => this.finish(id, 'Viewer lease expired'), (e.offer.purpose==='file'?24:1) * 60 * 60 * 1000); }
  }
  close(id: string, parent: SecureChannel, reason: string) { if (this.entries.get(id)?.parent === parent) this.finish(id, reason); }
  closeParent(parent: SecureChannel) { for (const [id,e] of this.entries) if (e.parent === parent) this.finish(id, 'Parent disconnected'); }
  closeAll() { for (const id of this.entries.keys()) this.finish(id, 'Server stopped'); }
  has(id: string) { return this.entries.has(id); }
  closeId(id: string, reason = "Transfer paused") { this.finish(id, reason); }
  private finish(id: string, reason: string) {
    const e = this.entries.get(id); if (!e) return;
    this.entries.delete(id); clearTimeout(e.timer); e.settle(new Error(reason));
    e.device?.close(); e.owner?.close();
    try { e.parent.send({ type: 'stream_close', id, reason }); } catch { /* parent closed */ }
  }
}
