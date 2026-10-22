/**
 * How many error messages per second may be scrubbed (DECISIONS #105): past
 * it, errors still go out, without their message, so an error storm cannot
 * spend the host app's CPU on text. A token bucket, refilled continuously.
 */
export class ScrubBudget {
  private tokens: number;
  private last: number;

  constructor(private readonly perSecond: number, private readonly now: () => number) {
    this.tokens = perSecond;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perSecond, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface SamplerOptions {
  /** Queue fill (0..1) above which request events start being sampled. */
  threshold: number;
  /** Lowest keep rate when the queue is nearly full. */
  minRate: number;
  random?: () => number;
}

/**
 * Load shedding for request events only. Below the threshold everything is
 * kept. Above it, the keep rate falls linearly to `minRate` as the queue
 * fills. Errors, metrics and lifecycle events are never sampled.
 */
export class Sampler {
  private readonly random: () => number;

  constructor(private readonly opts: SamplerOptions) {
    this.random = opts.random ?? Math.random;
  }

  /** Keep rate for the given queue fill. */
  rate(fill: number): number {
    const { threshold, minRate } = this.opts;
    if (fill <= threshold) return 1;
    const over = Math.min(1, (fill - threshold) / (1 - threshold));
    return Math.max(minRate, 1 - over * (1 - minRate));
  }

  /** Returns the keep rate if the event should be kept, or 0 to drop it. */
  decide(fill: number): number {
    const r = this.rate(fill);
    if (r >= 1) return 1;
    return this.random() < r ? r : 0;
  }
}
