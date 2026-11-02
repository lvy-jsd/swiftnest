import type { ApiWebSocket } from './types.js';
import { ApiError, Inbox } from './transport.js';
export interface LiveOffer { id: string; sendKey: string; receiveKey: string; maxFrame: number; maxDimension: number; displayId: string }
export interface ScreenFrame { captureId: string; displayId: string; width: number; height: number; scaleFactor: number; mime: string; image: Uint8Array }
export type LiveUpdate = { control: 'ivy' | 'owner' | 'paused'; frame?: ScreenFrame; error?: { code: string; message: string } };
const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
/** Browser/native-compatible AEAD. Requires a secure WebView or HTTPS browser context. */
export class LiveView extends Inbox<LiveUpdate> {
  private finishClosed: () => void = () => {};
  readonly closed = new Promise<void>(resolve => { this.finishClosed=resolve; });
  private sendSeq = 0n;
  private receiveSeq = 0n;
  private writes = Promise.resolve();
  private reads = Promise.resolve();
  private pendingWrites = 0;
  private pendingReads = 0;
  private stopped = false;
  private control: LiveUpdate['control'] = 'ivy';
  private constructor(private socket: ApiWebSocket, private offer: LiveOffer, private sendKey: CryptoKey, private receiveKey: CryptoKey) {
    super(() => socket.close(), 2);
    socket.addEventListener('message', event => {
      if (this.pendingReads++ >= 4) { this.fail('Viewer cannot decode frames fast enough'); return; }
      this.reads = this.reads.then(() => this.receive(event.data)).catch(() => this.fail('Screen stream integrity check failed')).finally(() => { this.pendingReads--; });
    });
    socket.addEventListener('close', () => this.fail('Live view disconnected'));
    socket.addEventListener('error', () => this.fail('Live view connection failed'));
  }
  static async open(socket: ApiWebSocket, offer: LiveOffer, timeout = 15000): Promise<LiveView> {
    if (!globalThis.crypto?.subtle) { socket.close(); throw new ApiError('secure-context-required', 'Use the native App or HTTPS for live view'); }
    const [send, receive] = await Promise.all([offer.sendKey,offer.receiveKey].map(key => crypto.subtle.importKey('raw',decode(key), 'AES-GCM',false,['encrypt','decrypt'])));
    const live = new LiveView(socket,offer,send!,receive!);
    await new Promise<void>((resolve,reject) => {
      const timer=setTimeout(() => {socket.close();reject(new ApiError('timeout','Live view did not open'));},timeout);
      const cleanup=() => {clearTimeout(timer);socket.removeEventListener('error',fail);socket.removeEventListener('close',fail);};
      const fail=() => {cleanup();reject(new ApiError('disconnected','Live view failed to open'));};
      socket.addEventListener('error',fail,{once:true}); socket.addEventListener('close',fail,{once:true});
      const ready=() => {cleanup();live.event({type:'ready'}).then(resolve,reject);};
      if (socket.readyState===1) ready(); else socket.addEventListener('open',ready,{once:true});
    });
    return live;
  }
  takeOver() { return this.event({type:'takeover'}); }
  handBack() { return this.event({type:'handback'}); }
  input(tool: string, args: Record<string, unknown>) {
    if (this.control!=='owner') return Promise.reject(new ApiError('take-over-required','Take over before sending input'));
    return this.event({type:'input',tool,args});
  }
  private event(value: unknown): Promise<void> {
    if (this.stopped || this.pendingWrites>=32) return Promise.reject(new ApiError('stream-busy','Input stream is closed or busy'));
    const plain=new TextEncoder().encode(JSON.stringify(value));
    if (plain.length>60000) return Promise.reject(new ApiError('input-too-large','Input is too long'));
    this.pendingWrites++;
    const job=this.writes.then(async () => {
      if (this.stopped || this.sendSeq>=0xffffffffffffffffn) throw new Error('Stream closed');
      const header=this.header(this.sendSeq++,2,plain.length), nonce=new Uint8Array(12);
      nonce.set(header.subarray(17,25),4);
      const body=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:header},this.sendKey,plain);
      const frame=new Uint8Array(30+body.byteLength);frame.set(header);frame.set(new Uint8Array(body),30);this.socket.send(frame);
    }).finally(() => {this.pendingWrites--;});
    this.writes=job.catch(() => this.fail('Input stream failed'));return job;
  }
  private header(seq: bigint, flag: number, length: number) {
    const h=new Uint8Array(30);h[0]=1;
    for(let i=0;i<16;i++) h[1+i]=parseInt(this.offer.id.slice(i*2,i*2+2),16);
    const v=new DataView(h.buffer);v.setBigUint64(17,seq);h[25]=flag;v.setUint32(26,length);return h;
  }
  private async receive(data: unknown) {
    if(this.stopped)return;
    const f=data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : typeof Blob!=='undefined' && data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : undefined;
    if (!f || f.length<46 || f.length>this.offer.maxFrame+46) throw new Error('Frame size');
    const view=new DataView(f.buffer,f.byteOffset,f.byteLength), length=view.getUint32(26);
    const expected=this.header(this.receiveSeq,f[25]!,length);
    if(length!==f.length-46 || expected.some((v,i)=>v!==f[i]) || ![1,3].includes(f[25]!)) throw new Error('Frame header or replay');
    const nonce=new Uint8Array(12);nonce.set(f.subarray(17,25),4);
    const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:f.slice(0,30)},this.receiveKey,f.slice(30)));
    this.receiveSeq++;
    if(f[25]===3) {
      const state=JSON.parse(new TextDecoder().decode(plain));
      if(!['owner','ivy'].includes(state.control)) throw new Error('Control state');
      this.control=state.control;this.push({control:this.control,...(state.error?{error:state.error}:{})});
    } else {
      if(plain.length<4) throw new Error('Frame metadata');
      const n=new DataView(plain.buffer).getUint32(0);if(n>8192 || n+4>=plain.length) throw new Error('Frame metadata');
      const meta=JSON.parse(new TextDecoder().decode(plain.subarray(4,4+n)));
      if(!Number.isInteger(meta.width)||!Number.isInteger(meta.height)||meta.width<1||meta.height<1||meta.width>2560||meta.height>2560||!['image/jpeg','image/webp'].includes(meta.mime)||typeof meta.captureId!=='string'||typeof meta.displayId!=='string') throw new Error('Frame dimensions');
      this.push({control:this.control,frame:{...meta,image:plain.slice(4+n)}});
      await this.event({type:'frame_ack',frame:meta.frameSeq});
    }
  }
  private fail(message: string) {
    if(this.stopped)return;this.stopped=true;this.control='paused';this.push({control:'paused',error:{code:'live-view-ended',message}});this.end();this.socket.close();this.finishClosed();
  }
  override close() {if(this.stopped)return;this.stopped=true;super.close();this.finishClosed();}
}
