// Every agent tunable in one place. Rules and arithmetic only (SPEC: no ML).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Windows end this far before now, so events still in SDK queues or being
 * retried land in the window they belong to before it is judged.
 */
export const EVAL_LAG_MS = 45_000;

/** End of the windows an agent run starting at `now` judges. */
export const windowEnd = (now: number, lagMs = EVAL_LAG_MS): number => now - lagMs;

export const SCHEDULE = {
  health: { everyMs: MINUTE, timeoutMs: 20_000 },
  watchdog: { everyMs: MINUTE, timeoutMs: 20_000 },
  usage: { everyMs: 15 * MINUTE, timeoutMs: 60_000 },
  /** Not an agent: the hourly rollup runs in the main thread. */
  rollup: { everyMs: HOUR },
} as const;

export const FINDINGS = {
  /** A finding resolved this recently is reopened instead of duplicated. */
  cooldownMs: 30 * MINUTE,
  /** Evaluated runs without a finding before it resolves (AGENTS.md: 3 good runs). */
  resolveAfter: 3,
  /** Status turns grey when Health has not completed a run for this long. */
  statusFreshMs: 3 * MINUTE,
};

export const ROLLUP = {
  /** Closed hours re-rolled each hour, for late retries (DECISIONS #18). */
  rerollHours: 3,
  /** How far back missing hours are backfilled. */
  backfillMs: 28 * DAY,
  /** Hours backfilled per app per tick, so ingest is never blocked for long. */
  backfillPerTick: 24,
};

export const WATCHDOG = {
  /** Heartbeat interval assumed until enough heartbeats are seen. */
  defaultHeartbeatMs: MINUTE,
  /** Heartbeats needed before the learned interval is trusted. */
  minHeartbeats: 3,
  /** Silent after max(silentFactor × usual gap, silentMinMs). */
  silentFactor: 3,
  silentMinMs: 3 * MINUTE,
  /**
   * The SDK's longest circuit-breaker cooldown (maxCooldownMs in
   * @abigaail/core). After Abigaail restarts, an app may wait this long before
   * it sends again, so silence within this + the silent threshold of the
   * restart is "reconnecting" (grey), never critical.
   */
  sdkMaxBackoffMs: 5 * MINUTE,
  /** A gap this long in Abigaail's own run history is reported as downtime. */
  downMinMs: 3 * MINUTE,
  /** Window for ingest refusals (403, 429, unknown-key 401). */
  rejectionWindowMs: 5 * MINUTE,
  /** Unknown-key requests in the window before Abigaail reports them. */
  unknownKeyMin: 50,
  /** An agent is stalled when its last good run is older than this many schedules. */
  stalledFactor: 3,
  /** Consecutive failed runs that make an agent "failing". */
  failingRuns: 3,
  /** Median run time above this share of the timeout is "slowing". */
  slowShare: 0.5,
  slowRuns: 10,
  /** The salt check waits this long after UTC midnight for rotation to happen. */
  saltGraceMs: 5 * MINUTE,
  /** Disk: days left at the current growth rate. */
  diskWarnDays: 14,
  diskCriticalDays: 3,
  /** Growth is measured over at least this span of size samples. */
  growthMinSpanMs: HOUR,
  /** /healthz turns 503 when the Watchdog has not completed a run for this long. */
  healthzStaleMs: 3 * MINUTE,
};
