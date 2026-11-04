export const DEFAULT_LIMITS = {
  connections: 128,
  perServer: 8,
  bytesPerSecond: 256 * 1024,
  burstBytes: 1024 * 1024,
  framesPerSecond: 128,
};
export type RelayLimits = typeof DEFAULT_LIMITS;
/** One shared budget per server, in both directions; token buckets never accumulate beyond a burst. */
export class Budget {
  private updated = Date.now();
  private bytes: number;
  private frames: number;
  constructor(private limits: RelayLimits) {
    this.bytes = limits.burstBytes;
    this.frames = limits.framesPerSecond;
  }
  take(size: number): boolean {
    const now = Date.now();
    const seconds = (now - this.updated) / 1000;
    this.updated = now;
    this.bytes = Math.min(this.limits.burstBytes, this.bytes + seconds * this.limits.bytesPerSecond) - size;
    this.frames = Math.min(this.limits.framesPerSecond, this.frames + seconds * this.limits.framesPerSecond) - 1;
    return this.bytes >= 0 && this.frames >= 0;
  }
}
