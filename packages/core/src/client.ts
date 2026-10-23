import {
  SCHEMA_VERSION,
  eventFeature,
  type AbigaailEvent,
  type Batch,
  type Environment,
  type EventInput,
} from "@abigaail/schema";
import { CircuitBreaker, type BreakerState } from "./breaker.js";
import { BoundedQueue } from "./queue.js";
import { sanitizeEvent, type SanitizeContext } from "./sanitize.js";
import { Sampler, ScrubBudget } from "./sampler.js";
import { fetchTransport, type SendResult, type Transport } from "./transport.js";

export const SDK_NAME = "@abigaail/core";
/** Outbound hosts remembered for the scrubber's host rule. */
const MAX_KNOWN_HOSTS = 500;
export const SDK_VERSION = "0.1.0";

export interface ClientOptions {
  /** Full ingest URL, e.g. "http://localhost:4318/ingest". */
  endpoint: string;
  /** Per-app, write-only ingest key. */
  ingestKey: string;
  /** Deploy version, e.g. a git SHA. */
  release: string;
  environment: Environment;
  /** Set false to turn the SDK into a no-op (e.g. in tests). Default true. */
  enabled?: boolean;
  /** Max events held in memory. Default 1000. */
  maxQueue?: number;
  /** Max events per POST. Default 100. */
  batchSize?: number;
  /** Background flush interval. Default 5000 ms. 0 disables the timer. */
  flushIntervalMs?: number;
  /** Per-send timeout. Default 2000 ms. */
  timeoutMs?: number;
  /** Queue fill above which request events are sampled. Default 0.5. */
  sampleThreshold?: number;
  breaker?: { failureThreshold?: number; baseCooldownMs?: number; maxCooldownMs?: number };
  /** Override the network layer (tests, custom runtimes). */
  transport?: Transport;
  /** Called (never awaited, errors swallowed) when the SDK hits an internal problem. */
  onInternalError?: (err: unknown) => void;
  /**
   * Send error messages, after the shared scrubber removes anything personal
   * (DECISIONS #101). Default true; false sends class names and codes only.
   */
  errorMessages?: boolean;
  /** Error messages scrubbed per second at most; the rest are sent without. Default 100. */
  maxScrubsPerSecond?: number;
  now?: () => number;
  random?: () => number;
}

export interface ClientStats {
  queued: number;
  /** Dropped because the queue was full. */
  dropped: number;
  /** Dropped because the event could not be made valid (see sanitize.ts). */
  invalid: number;
  sampledOut: number;
  sent: number;
  rejected: number;
  failedSends: number;
  /**
   * Not sent because the server has not announced the schema feature they need
   * (DECISIONS #110). Not a loss of data the server could take, so it is not
   * part of sdk_dropped_events.
   */
  unsupported: number;
  breaker: BreakerState;
}

export interface AbigaailClient {
  /** Queue an event. Synchronous, never throws, never blocks on the network. */
  capture(event: EventInput): void;
  /** Send what is queued. Resolves within the timeout, never rejects. */
  flush(): Promise<void>;
  /** Stop the timer and make one bounded final flush. Never rejects. */
  shutdown(timeoutMs?: number): Promise<void>;
  stats(): ClientStats;
  /**
   * The schema features the server announced in its latest 202, or undefined
   * before the first accepted batch.
   */
  features(): ReadonlySet<string> | undefined;
}

function uuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 fallback for runtimes without randomUUID.
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const NOOP_STATS: ClientStats = {
  queued: 0,
  dropped: 0,
  invalid: 0,
  sampledOut: 0,
  sent: 0,
  rejected: 0,
  failedSends: 0,
  unsupported: 0,
  breaker: "closed",
};

/** A client that does nothing. Returned when disabled or misconfigured. */
export function noopClient(): AbigaailClient {
  return {
    capture() {},
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    stats: () => ({ ...NOOP_STATS }),
    features: () => undefined,
  };
}

/**
 * Create the event client. Fail-open by construction: if configuration is
 * invalid this returns a no-op client rather than throwing into the host app.
 */
export function createClient(opts: ClientOptions): AbigaailClient {
  const report = (err: unknown) => {
    try {
      opts.onInternalError?.(err);
    } catch {
      // A broken error hook must not break the app either.
    }
  };

  try {
    if (opts.enabled === false) return noopClient();
    if (!opts.endpoint || !opts.ingestKey || !opts.release) {
      report(new Error("abigaail: endpoint, ingestKey and release are required; SDK disabled"));
      return noopClient();
    }
    return new Client(opts, report);
  } catch (err) {
    report(err);
    return noopClient();
  }
}

class Client implements AbigaailClient {
  private readonly queue: BoundedQueue<AbigaailEvent>;
  private readonly breaker: CircuitBreaker;
  private readonly sampler: Sampler;
  private readonly transport: Transport;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;
  private counters = { invalid: 0, sampledOut: 0, sent: 0, rejected: 0, failedSends: 0, unsupported: 0 };
  /** Features the server announced in its latest 202; undefined until one arrives. */
  private announced: ReadonlySet<string> | undefined;
  /** The app's outbound hosts seen so far: the only hostnames an error message may keep. */
  private readonly hosts = new Set<string>();
  private readonly sanitize: SanitizeContext;

  constructor(
    private readonly opts: ClientOptions,
    private readonly report: (err: unknown) => void,
  ) {
    this.now = opts.now ?? Date.now;
    this.queue = new BoundedQueue(opts.maxQueue ?? 1000);
    this.batchSize = Math.max(1, opts.batchSize ?? 100);
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.breaker?.failureThreshold ?? 3,
      baseCooldownMs: opts.breaker?.baseCooldownMs ?? 30_000,
      maxCooldownMs: opts.breaker?.maxCooldownMs ?? 300_000,
      now: this.now,
    });
    this.sampler = new Sampler({
      threshold: opts.sampleThreshold ?? 0.5,
      minRate: 0.05,
      ...(opts.random ? { random: opts.random } : {}),
    });
    this.transport =
      opts.transport ?? fetchTransport({ endpoint: opts.endpoint, ingestKey: opts.ingestKey });
    const budget = new ScrubBudget(Math.max(0, opts.maxScrubsPerSecond ?? 100), this.now);
    this.sanitize = {
      messages: opts.errorMessages !== false,
      scrubBudget: () => budget.take(),
      knownHost: (h) => this.hosts.has(h),
      onHost: (h) => {
        if (this.hosts.size < MAX_KNOWN_HOSTS) this.hosts.add(h);
      },
    };

    const interval = opts.flushIntervalMs ?? 5000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.flush(), interval);
      // Never keep the host process alive just to send telemetry.
      this.timer.unref?.();
    }
  }

  capture(input: EventInput): void {
    try {
      if (this.closed) return;
      // Rebuilt from allowed fields and mapped to values ingest accepts.
      const event = sanitizeEvent(input, uuid, this.now, this.sanitize);
      if (!event) {
        this.counters.invalid++;
        return;
      }
      // Optional schema parts only once this server has said it takes them.
      if (!this.supported(event)) {
        this.counters.unsupported++;
        return;
      }

      // Only request events are sampled. Errors, metrics, outbound calls and
      // lifecycle events carry the signals agents need most and are low
      // volume, so they are always kept (unless the queue is full).
      if (event.type === "request") {
        const rate = this.sampler.decide(this.queue.fill);
        if (rate === 0) {
          this.counters.sampledOut++;
          return;
        }
        if (rate < 1) event.sample_rate = rate;
      }

      this.queue.push(event);
      // A full batch is ready: send it soon, but never on this call stack.
      if (this.queue.size >= this.batchSize) queueMicrotask(() => void this.flush());
    } catch (err) {
      this.report(err);
    }
  }

  flush(): Promise<void> {
    // One send loop at a time; concurrent callers share it.
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.size > 0 && this.breaker.allowRequest()) {
        // Checked again here: the server may have announced less since an event was queued.
        const taken = this.queue.take(this.batchSize);
        const events = taken.filter((e) => this.supported(e));
        this.counters.unsupported += taken.length - events.length;
        if (!events.length) continue;
        const batch: Batch = {
          schema_version: SCHEMA_VERSION,
          sdk: { name: SDK_NAME, version: SDK_VERSION },
          release: this.opts.release,
          environment: this.opts.environment,
          // Per attempt, so a retried batch tells ingest how long its events waited.
          sent_at: this.now(),
          events,
        };
        const outcome = await this.sendWithTimeout(batch);
        const result = typeof outcome === "string" ? outcome : outcome.result;
        if (result === "ok") {
          this.announced = new Set(typeof outcome === "string" ? [] : (outcome.features ?? []));
          this.breaker.recordSuccess();
          this.counters.sent += events.length;
        } else if (result === "rejected") {
          // The server says the batch is invalid; resending it will not help.
          this.breaker.recordSuccess();
          this.counters.rejected += events.length;
        } else {
          this.breaker.recordFailure();
          this.counters.failedSends++;
          // Safe to resend later: event_id makes ingest idempotent.
          this.queue.requeue(events);
          return;
        }
      }
    } catch (err) {
      this.report(err);
    }
  }

  private supported(event: AbigaailEvent): boolean {
    const feature = eventFeature(event);
    return feature === undefined || this.announced?.has(feature) === true;
  }

  private async sendWithTimeout(batch: Batch): Promise<SendResult | { result: SendResult; features?: readonly string[] }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"failed">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("failed");
      }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      // Race, so even a transport that ignores the abort signal cannot stall us.
      const send = Promise.resolve()
        .then(() => this.transport(batch, controller.signal))
        .catch(() => "failed" as const);

      return await Promise.race([send, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(timeoutMs = 1000): Promise<void> {
    try {
      if (this.closed) return;
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          t = setTimeout(resolve, timeoutMs);
          t.unref?.();
        }),
      ]);
      clearTimeout(t);
    } catch (err) {
      this.report(err);
    }
  }

  stats(): ClientStats {
    return {
      queued: this.queue.size,
      dropped: this.queue.dropped,
      ...this.counters,
      breaker: this.breaker.state,
    };
  }

  features(): ReadonlySet<string> | undefined {
    return this.announced;
  }
}
