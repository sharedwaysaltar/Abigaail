export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** First cooldown once open; doubles on each failed probe. */
  baseCooldownMs: number;
  maxCooldownMs: number;
  now?: () => number;
}

/**
 * Stops the SDK hammering an ingest endpoint that is down. While open, no
 * sends are attempted. After the cooldown, one probe is allowed (half-open):
 * success closes the circuit, failure reopens it with a longer cooldown.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private cooldownMs: number;
  private stateValue: BreakerState = "closed";
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.cooldownMs = opts.baseCooldownMs;
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.stateValue === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.stateValue = "half_open";
    }
    return this.stateValue;
  }

  /** Whether a send may be attempted right now. */
  allowRequest(): boolean {
    return this.state !== "open";
  }

  recordSuccess(): void {
    this.failures = 0;
    this.cooldownMs = this.opts.baseCooldownMs;
    this.stateValue = "closed";
  }

  recordFailure(): void {
    if (this.state === "half_open") {
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.opts.maxCooldownMs);
      this.trip();
      return;
    }
    this.failures++;
    if (this.failures >= this.opts.failureThreshold) this.trip();
  }

  private trip(): void {
    this.stateValue = "open";
    this.openedAt = this.now();
    this.failures = 0;
  }
}
