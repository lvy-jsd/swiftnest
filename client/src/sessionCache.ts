import type { SwiftnestClient, SwiftnestEvent } from '@swiftnest/api';
import { chatReducer, emptyChat, type ChatState } from './chat';
import { chatTimeline, type ChatTimeline } from './chatPresentation';
import { watchChatSession } from './chatSession';

interface Snapshot {
  state: ChatState;
  timeline: ChatTimeline;
  ready: boolean;
}
interface Entry {
  snapshot: Snapshot;
  listeners: Set<() => void>;
  stop?: () => void;
}

/** Connection-scoped LRU. Hidden chats keep following so switching never replays a snapshot.
 * This is a bounded live view, not a durable/offline copy of the server's session log.
 */
export class SessionCache {
  private entries = new Map<string, Entry>();
  constructor(private readonly limit = 64) {}

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { snapshot: { state: emptyChat(), timeline: {}, ready: false }, listeners: new Set() };
      this.entries.set(id, entry);
    }
    return entry;
  }
  getSnapshot = (id: string): Snapshot => this.entry(id).snapshot;
  subscribe = (id: string, listener: () => void) => {
    const entry = this.entry(id);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  };
  private publish(entry: Entry, patch: Partial<Snapshot>) {
    entry.snapshot = { ...entry.snapshot, ...patch };
    for (const listener of entry.listeners) listener();
  }
  follow(
    id: string,
    client: SwiftnestClient,
    callbacks: { event: (event: SwiftnestEvent) => void; failed: () => SwiftnestEvent | undefined },
  ): void {
    const entry = this.entry(id);
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (!entry.stop) {
      entry.stop = watchChatSession(client, id, {
        ready: (ready) => this.publish(entry, { ready }),
        event: (event) => {
          this.publish(entry, {
            state: chatReducer(entry.snapshot.state, event),
            timeline: chatTimeline(entry.snapshot.timeline, event),
          });
          callbacks.event(event);
        },
        failed: () => {
          const event = callbacks.failed();
          if (event) this.publish(entry, { state: chatReducer(entry.snapshot.state, event) });
        },
      });
    }
    for (const [key, candidate] of this.entries) {
      if (this.entries.size <= this.limit) break;
      if (key === id || candidate.listeners.size) continue;
      candidate.stop?.();
      this.entries.delete(key);
    }
  }
  /** Called before a connection is replaced/revoked: no transcripts cross server identities. */
  clear(): void {
    for (const [id, entry] of this.entries) {
      entry.stop?.();
      entry.stop = undefined;
      if (entry.listeners.size) this.publish(entry, { state: emptyChat(), timeline: {}, ready: false });
      else this.entries.delete(id);
    }
  }
}
