/** Bounded per-IP admission for unauthenticated sockets. No timers or address logging. */
export class HandshakeLimits {
  private entries = new Map<string, { active: number; attempts: number; since: number }>();
  constructor(
    private concurrent = 8,
    private perMinute = 60,
    private maxEntries = 2048,
  ) {}
  enter(address: string): (() => void) | undefined {
    const now = Date.now();
    for (const [key, item] of this.entries) if (!item.active && now - item.since >= 60000) this.entries.delete(key);
    let item = this.entries.get(address);
    if (!item) {
      if (this.entries.size >= this.maxEntries) return;
      item = { active: 0, attempts: 0, since: now };
      this.entries.set(address, item);
    }
    if (now - item.since >= 60000) {
      item.since = now;
      item.attempts = 0;
    }
    if (item.active >= this.concurrent || item.attempts >= this.perMinute) return;
    item.active++;
    item.attempts++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      item.active--;
    };
  }
}
