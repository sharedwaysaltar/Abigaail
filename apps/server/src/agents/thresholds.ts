// Every agent tunable in one place. Rules and arithmetic only (SPEC: no ML).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Shared with the dashboard, re-exported so every tunable is findable here.
import { BASELINE, STATUS_FRESH_MS } from "@abigaail/insights";

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
  collapseMinSpanMs: 5 * MINUTE,

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

/**
 * Retention (DECISIONS #87, #88). Days kept per table, the minimum allowed and
 * the variable that changes it: ABIGAAIL_RETAIN_<env>_DAYS. A value that is
 * not a whole number, below the minimum or above maxDays stops the server.
 */
export const RETENTION = {
  periods: {
    /** Raw events: the only monitoring data with a pseudonymous ID (visitor_hash). */
    events: { env: "EVENTS", days: 30, minDays: 7 },
    /** Hourly rollups: baselines need the same hour-of-week over BASELINE.weeks, plus the week being judged. */
    rollups: { env: "ROLLUPS", days: 400, minDays: (BASELINE.weeks + 1) * 7 },
    /** Unique humans per day: Usage compares the same weekday over BASELINE.weeks. */
    daily_uniques: { env: "DAILY", days: 400, minDays: (BASELINE.weeks + 1) * 7 },
    /** Resolved findings only; open findings are never deleted. */
    findings: { env: "FINDINGS", days: 180, minDays: 30 },
    /** The newest ok run of each agent is always kept. */
    agent_runs: { env: "AGENT_RUNS", days: 30, minDays: 7 },
    ingest_rejections: { env: "REJECTIONS", days: 30, minDays: 1 },
    db_size_samples: { env: "DB_SIZE", days: 90, minDays: 2 },
    /** Admin audit logs of both databases. */
    audit_log: { env: "AUDIT", days: 400, minDays: 90 },
    /** Alert messages (and which findings each carried) and alert states that owe nothing. */
    alerts: { env: "ALERTS", days: 90, minDays: 7 },
  },
  maxDays: 3650,
  /** Rows per delete transaction: ingest waits at most one batch. */
  batchRows: 1000,
  /** Rolled-up hours per delete transaction (each hour has one row per route, host, ...). */
  rollupHoursPerBatch: 6,
  /** Work per run; what is left carries over to a catch-up run. */
  budgetMs: 10_000,
  /** Runs hourly at this minute, away from the rollup just after the hour. */
  runAtMinute: 30,
  /** While behind (work left), the next run comes this soon instead of next hour. */
  catchUpMs: 5 * MINUTE,
  /** Free pages returned to the filesystem per incremental_vacuum step (4 KiB each). */
  vacuumPages: 2000,
  /** Attempts to truncate the WAL before the run counts as failed, this far apart (never blocking). */
  checkpointTries: 3,
  checkpointRetryMs: 1_000,
  /** Watchdog: data this long past its period is "retention behind" (warning)... */
  behindWarnMs: 6 * HOUR,
  /** ...and critical after this long. */
  behindCriticalMs: 2 * DAY,
} as const;

export type RetentionPeriod = keyof typeof RETENTION.periods;

/**
 * Alerts (DECISIONS #95-#99). Only confirmed red findings notify (isRed in
 * the store); the alerter runs in the server's main thread and never waits
 * on a channel.
 */
export const ALERTS = {
  /** One sweep a minute, this long after the minute, when the agents' runs of that minute are done. */
  sweepEveryMs: MINUTE,
  sweepOffsetMs: 15_000,
  /** At most one "firing" message per fingerprint in this long (same as the findings reopen cooldown). */
  cooldownMs: FINDINGS.cooldownMs,
  /** Findings listed in one message; the rest are counted ("and 4 more"). */
  maxItems: 10,
  /** Messages per channel per hour; past it, one "storm" message and the rest only on the dashboard. */
  perChannelPerHour: 20,
  /** Messages waiting per channel in memory; past it the oldest is given up. */
  queueMax: 100,
  webhookTimeoutMs: 10_000,
  /** The whole SMTP conversation; nodemailer's own connect/greeting/socket timeouts are shorter. */
  smtpTimeoutMs: 30_000,
  /** Waits before each retry; after the last one the message is given up. */
  retryDelaysMs: [30_000, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  /** A message still pending at startup is resumed if younger than this, else given up. */
  resumeMaxAgeMs: 30 * MINUTE,
  /** Bytes of a receiver's answer that are read before the socket is closed. */
  responseMaxBytes: 4096,
  /** Watchdog: consecutive failed attempts on a channel before alert_delivery_failed. */
  failingAttempts: 3,
  /** Dead-man's switch: ping ABIGAAIL_HEARTBEAT_URL this often while /healthz is ok. */
  heartbeatEveryMs: 5 * MINUTE,
  heartbeatTimeoutMs: 10_000,
  minSecretLength: 32,
  maxRecipients: 5,
  /** Discord rejects longer content. */
  discordMaxChars: 2000,
};
/** Days kept per table, as loaded from the environment. */
export type RetentionDays = Record<RetentionPeriod, number>;
