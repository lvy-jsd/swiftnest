import type { ApiWebSocket, ClientOptions, SocketEventMap } from '@swiftnest/api';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import NativeWebSocket from '@tauri-apps/plugin-websocket';

/** Adapt the async plugin to the synchronous WebSocket factory expected by the API. */
export class NativeSocket implements ApiWebSocket {
  readyState = 0;
  private socket?: NativeWebSocket;
  private unlisten?: () => void;
  private listeners = new Map<keyof SocketEventMap, Map<(event: never) => void, boolean>>();
  private writes = Promise.resolve();
  constructor(url: string, headers: Readonly<Record<string, string>>) {
    void NativeWebSocket.connect(url, { headers })
      .then((socket) => {
        if (this.readyState === 3) {
          void socket.disconnect().catch(() => {});
          return;
        }
        this.socket = socket;
        this.unlisten = socket.addListener((message) => {
          if (message.type === 'Text') this.emit('message', { data: message.data });
          else if (message.type === 'Binary') this.emit('message', { data: new Uint8Array(message.data) });
          else if (message.type === 'Close') this.close();
        });
        this.readyState = 1;
        this.emit('open', {});
      })
      .catch(() => this.fail());
  }
  addEventListener<K extends keyof SocketEventMap>(
    type: K,
    listener: (event: SocketEventMap[K]) => void,
    options?: { once?: boolean },
  ): void {
    const group = this.listeners.get(type) ?? new Map();
    group.set(listener as (event: never) => void, options?.once ?? false);
    this.listeners.set(type, group);
  }
  removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void {
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }
  private emit<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]) {
    for (const [listener, once] of [...(this.listeners.get(type) ?? [])]) {
      if (once) this.listeners.get(type)?.delete(listener);
      listener(event as never);
    }
  }
  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.readyState !== 1) throw new Error('Socket is closed');
    // Preserve RPC/stream ordering even though the plugin sends asynchronously.
    this.writes = this.writes
      .then(async () => {
        if (this.readyState === 1) await this.socket!.send(typeof data === 'string' ? data : Array.from(data));
      })
      .catch(() => this.fail());
  }
  private fail() {
    if (this.readyState !== 3) {
      this.emit('error', {});
      this.close();
    }
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unlisten?.();
    void this.socket?.disconnect().catch(() => {});
    this.emit('close', {});
    this.listeners.clear();
  }
}
export function nativeOptions(): ClientOptions {
  return {
    cookieMode: 'manual',
    // redirect:'manual' alone does not configure reqwest. Never forward an API
    // cookie to a redirect target, including for unary requests.
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      // The official plugin otherwise inserts the WebView Origin. Its documented
      // unsafe-headers + empty Origin opt-out makes this a native request.
      headers.set('origin', '');
      return nativeFetch(input, { ...init, headers, maxRedirections: 0 });
    },
    createWebSocket: (url, { headers }) => new NativeSocket(url, headers),
  };
}
