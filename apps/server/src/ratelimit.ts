/** Token bucket: `ratePerSec` tokens refill per second, up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.ratePerSec);
  }

  /** Take one token. Returns false when empty. */
  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Seconds until the next token, for a retry-after header. */
  retryAfterSec(): number {
    this.refill();
    if (this.tokens >= 1 || this.ratePerSec <= 0) return 1;
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.ratePerSec)));
  }
}
