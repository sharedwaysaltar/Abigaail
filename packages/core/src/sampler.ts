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
