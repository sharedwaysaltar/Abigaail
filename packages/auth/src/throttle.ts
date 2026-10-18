// In-memory token buckets keyed by a string (a source address). Nothing here
// is ever stored or logged; the map is bounded, oldest keys evicted first.

export class Throttle {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    /** Attempts allowed at once. */
    private readonly burst: number,
    /** One attempt comes back every this many ms. */
    private readonly refillMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Spend one attempt for `key`; false when it has none left. */
  take(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.burst, b.tokens + (t - b.at) / this.refillMs);
      b.at = t;
      // Re-insert so the map's order is least recently used first.
      this.buckets.delete(key);
    } else {
      b = { tokens: this.burst, at: t };
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }
}
