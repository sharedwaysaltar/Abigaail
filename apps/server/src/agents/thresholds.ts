// Every agent tunable in one place. Rules and arithmetic only (SPEC: no ML).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Shared with the dashboard, re-exported so every tunable is findable here.
import { STATUS_FRESH_MS } from "@abigaail/insights";

// SCHEDULE lives in insights so the dashboard's Agents view shows the same schedules.
export { BASELINE, EVAL_LAG_MS, SCHEDULE, STATUS_FRESH_MS, windowEnd } from "@abigaail/insights";

export const FINDINGS = {
  /** A finding resolved this recently is reopened instead of duplicated. */
  cooldownMs: 30 * MINUTE,
  /** Evaluated runs without a finding before it resolves (AGENTS.md: 3 good runs). */
  resolveAfter: 3,
  /** Status turns grey when Health has not completed a run for this long. */
  statusFreshMs: STATUS_FRESH_MS,
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

export const HEALTH = {
  /** Fewer requests that matter than this in 15 min: "too little traffic to judge" (grey). */
  minRequests15: 20,

  // 5xx per route (Wilson lower bound on the failure share).
  minFailures: 5,
  errorWarnFloor: 0.02,
  errorWarnFactor: 3,
  errorCritical: 0.1,
  errorWarnNoBaseline: 0.05,
  // 401/403 per route.
  minAuthFailures: 10,
  authWarnFactor: 3,
  authWarnNoBaseline: 0.3,

  // Latency per route (5-minute p95).
  minLatencyRequests: 20,
  latencyCriticalRatio: 2.5,
  latencyWarnRatio: 1.75,
  /** Absolute increase needed as well, so 2 ms -> 6 ms is not an alert. */
  latencyFloorMs: 100,
  /** p95 must also exceed median + this many MADs of the route's normal. */
  latencyMads: 3,
  /** Without a normal yet: a p95 this high is still worth a warning. */
  latencyNoBaselineMs: 2_000,

  // Saturation.
  lagWarnMs: 100,
  lagCriticalMs: 500,
  /** Lag samples (one per 30 s by default) needed in the 5-minute window. */
  minLagSamples: 2,
  rssWarnRatio: 1.5,
  cpuWarnPercent: 90,
  /** Samples needed in the 15-minute window for RSS and CPU. */
  minResourceSamples: 3,
  slowestRoutes: 3,

  // Dependencies (per outbound host, 5-minute window).
  minCalls: 5,
  minLatencyCalls: 10,
  depWarnFloor: 0.05,
  depWarnFactor: 3,
  depCritical: 0.25,
  depWarnNoBaseline: 0.1,
  /** A route's 5xx folds into a host's finding when this share had a failed call to it. */
  foldShare: 0.5,

  // Traffic collapse (15-minute window).
  collapseMinExpected: 30,
  collapseShare: 0.1,
  collapseP: 0.001,
  /** Judged only over at least this much time since the latest boot. */
  collapseMinSpanMs: 10 * MINUTE,

  // New error bursts (15-minute window).
  minNewErrors: 3,
  errorBurstFactor: 5,
  errorHistoryMs: 7 * DAY,

  // Data trust.
  /** sdk_queue_size at this share of the SDK's default queue (1000) counts as near the cap. */
  queueNearCap: 800,
};

export const USAGE = {
  /** Change in yesterday's unique humans vs the same weekday that is worth noting. */
  uniquesChange: 0.5,
  uniquesMinAbs: 20,
  /** A route "goes quiet" only if at least this many requests were expected in the hour. */
  quietMinExpected: 10,
  quietP: 0.001,
  referrerMin: 10,
  referrerFactor: 3,
  referrerP: 0.001,
  /** A referrer domain unseen in this long counts as new. */
  referrerHistoryMs: 7 * DAY,
  /** Releases first seen this recently are checked for route adoption. */
  releaseWindowMs: 7 * DAY,
  peakMads: 4,
  peakFactor: 2,
  peakMin: 50,
};
