// Tunables shared by the agents (apps/server) and the dashboard, so both judge
// "normal" and "now" the same way. The agents' own tunables stay in
// apps/server/src/agents/thresholds.ts, which re-exports these.

/**
 * Windows end this far before now, so events still in SDK queues or being
 * retried land in the window they belong to before it is judged.
 */
export const EVAL_LAG_MS = 45_000;

/** End of the windows an agent run (or a dashboard read) starting at `now` judges. */
export const windowEnd = (now: number, lagMs = EVAL_LAG_MS): number => now - lagMs;

/** Which past hours count as "normal" (docs/AGENTS.md principle 1). */
export const BASELINE = {
  /** Same hour-of-week over this many past weeks... */
  weeks: 4,
  /** ...used when at least this many of them have data. */
  minWeeks: 2,
  /** Otherwise the same hour on this many past days, if at least minDays have data. */
  days: 7,
  minDays: 2,
  /** A slot's p95 counts towards a route's normal only with this many requests. */
  minSlotRequests: 5,
  /** Slots with a usable p95 needed for a latency normal. */
  minLatencySlots: 2,
};

/**
 * How often each agent runs and its hard timeout. The runner schedules from
 * this; the dashboard's Agents view shows it. A new agent adds a line here.
 */
export const SCHEDULE = {
  health: { everyMs: 60_000, timeoutMs: 20_000 },
  watchdog: { everyMs: 60_000, timeoutMs: 20_000 },
  usage: { everyMs: 15 * 60_000, timeoutMs: 60_000 },
  resilience: { everyMs: 60_000, timeoutMs: 20_000 },
  rollout: { everyMs: 60_000, timeoutMs: 20_000 },
  /** Not an agent: the hourly rollup runs in the main thread. */
  rollup: { everyMs: 3_600_000 },
  /** Not an agent: retention runs hourly in the main thread (every 5 min while catching up). */
  retention: { everyMs: 3_600_000 },
  /** Not an agent: the alerter's sweep runs in the main thread, only when a channel is configured. */
  alerts: { everyMs: 60_000 },
} as const;

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * The Resilience rules (docs/AGENTS.md, DECISIONS #111-#114). Shared because
 * Health folds its lag and memory findings into them and the dashboard shows
 * the same numbers: one judge per question.
 */
export const RESILIENCE = {
  // Restarts.
  /** A restart is reported while one happened this recently... */
  restartWindowMs: 15 * MIN,
  /** ...and is a loop at this many in that window, or at loopLong in loopLongMs. */
  loopShort: 3,
  loopLong: 5,
  loopLongMs: 2 * HOUR,
  /** How far before a boot the previous process's events are looked for. */
  historyMs: 24 * HOUR,
  /** A boot from an SDK with runtime signals waits this long for its ready event (instance). */
  readyWaitMs: 90_000,
  /** A new instance replaced one that went quiet at most this long before it booted... */
  replaceWithinMs: 5 * MIN,
  /** ...judged once this long has passed after the boot without the old one sending. */
  replaceWaitMs: 3 * MIN,
  /** An uncaught error this close before the process went quiet is its cause. */
  fatalWindowMs: MIN,
  /** Heap (or RSS) this close to its limit before a crash: likely out of memory. */
  oomShare: 0.9,
  /** Or: the last readings before the crash all rising, by at least max(MB, share of the low point). */
  oomRiseSamples: 3,
  oomRiseMb: 20,
  oomRiseShare: 0.5,

  // Leaks: a rising post-GC floor within one process lifetime.
  /** Caches and pools fill after a start: this long after a boot is not judged. */
  warmupMs: 30 * MIN,
  minSpanMs: 3 * HOUR,
  /** At most this much of the latest process's life is judged. */
  maxSpanMs: 48 * HOUR,
  /** The floor of each bucket is its lowest reading. */
  bucketMs: 15 * MIN,
  minBuckets: 8,
  /** Mann-Kendall z for p < 0.01, one-sided. */
  trendZ: 2.326,
  /** Growth over the span needed as well: max(share of the start, MB). */
  minGrowthShare: 0.1,
  minGrowthMb: 20,
  /** Critical when the trend reaches the limit within this long. */
  criticalWithinMs: 6 * HOUR,

  // Event-loop blocks per route.
  blockWindowMs: 15 * MIN,
  /** Blocks a route must be charged for, and the Wilson lower bound of its share of all blocks. */
  minBlocks: 5,
  minBlockShare: 0.5,
  /** Blocked time charged to it in the window. */
  minBlockedMs: 1_000,
  /** Critical: this many blocks in the last criticalWindowMs, averaging at least criticalAvgMs. */
  criticalBlocks: 3,
  criticalAvgMs: 500,
  criticalWindowMs: 5 * MIN,

  // Cold start.
  /** Earlier startups that form the normal. */
  startupHistory: 20,
  startupMinHistory: 3,
  startupRatio: 3,
  startupFloorMs: 2_000,
  startupMads: 3,
  /** Without a normal yet. */
  startupNoBaselineMs: 30_000,
  /** The first requests after a start, against the app's usual p95. */
  coldWindowMs: 5 * MIN,
  coldRatio: 2,
  coldMinRequests: 20,
  /** A slow start is reported for this long after the boot. */
  coldShowMs: HOUR,
};

/** Status turns grey when Health has not completed a run for this long. */
export const STATUS_FRESH_MS = 3 * 60_000;

/** What the dashboard needs before it shows a number instead of "too little data". */
export const VIEWS = {
  /** The "now" window for the four numbers and the app list. */
  windowMs: 15 * 60_000,
  /** Requests that matter in the window before a rate or p95 is shown (Health's minRequests15). */
  minRequests: 20,
  /** Lag samples in the window before event-loop lag is shown. */
  minLagSamples: 3,
  /** Outbound calls in the last hour before a dependency's failure share and p95 are shown. */
  minCalls: 5,
  /** The normal band is median ± bandMads × the scaled MAD (1.4826 × MAD) of hourly p95s... */
  bandMads: 3,
  /** ...and at least ± this share of the median, so a perfectly steady history is not a line. */
  bandMinShare: 0.1,
  /** "Routes that changed": p95 ratio and absolute change that count... */
  routeP95Ratio: 1.5,
  routeP95MinMs: 50,
  /** ...with at least this many requests in the hour. */
  routeMinRequests: 20,
  /** A traffic change counts when its Poisson tail is below this... */
  routeTrafficP: 0.01,
  /** ...and at least this many requests were expected (quieter) or seen (busier). */
  routeTrafficMin: 10,
  maxRouteChanges: 8,
  /** How far back "Earlier" looks. */
  earlierMs: 7 * 24 * 3_600_000,
  maxEarlier: 20,
  /** Resolved findings shown per app (from the last earlierMs). */
  maxResolved: 100,
  /** Top routes and referrers in the App page's Usage section. */
  usageTop: 5,
  /** Recent runs per agent on the Agents page. */
  agentRuns: 30,
};

/**
 * Rollout Safety (agent 5, DECISIONS #131-#133). Shared because Health and
 * Resilience fold into its findings and the Releases view shows its numbers.
 */
export const ROLLOUT = {
  /** A release is judged for this long after it was deployed (or until the next one). */
  judgeMs: 24 * HOUR,
  /**
   * Repeated looks: it is tested every minute for judgeMs, so every test is
   * corrected for this many looks as well as for the number of tests in the
   * run (a union bound: α / (tests × looks)).
   */
  looks: 1440,
  /** Family-wise error over a release's whole judgement: for "watch", and for "recommend rollback". */
  alphaWatch: 0.01,
  alphaRollback: 0.001,
  /** Nothing but a crash loop is judged in the first minutes after a deploy. */
  minObservedMs: 10 * MIN,

  // Errors per route: 5xx, and 4xx other than 401/403 (e.g. 404 on a route that used to answer).
  /** Requests that matter on a route since the deploy before its error shares are judged. */
  minRequests: 50,
  minFailures: 5,
  /** The Wilson lower bound of the new share must reach max(factor × usual, usual + floor). */
  errorFactor: 2,
  errorFloor: 0.02,
  /** Usual requests in the baseline before a route's own share is used (else the app's). */
  minBaselineRequests: 50,

  // Latency per route, over the latest window (the first minutes after the deploy are cold start, Resilience's).
  latencyWindowMs: 30 * MIN,
  warmupMs: 5 * MIN,
  minLatencyRequests: 30,
  /** p95 must reach this many times the usual p95, and this much more. */
  latencyRatio: 1.5,
  latencyFloorMs: 100,
  /** Under no change, this share of requests is above the usual p95. */
  aboveUsualShare: 0.05,

  // A route that went quiet.
  quietMinExpected: 20,
  quietShare: 0.1,

  // New error types.
  newErrorMin: 3,
  errorHistoryMs: 7 * 24 * HOUR,

  // Impact needed for "recommend rollback" (any one).
  /** Extra failures (above the usual share) of at least this share of all requests since the deploy... */
  excessShare: 0.05,
  /** ...or a route carrying this share of the usual traffic... */
  routeTrafficShare: 0.1,
  /** ...failing for at least this share of its requests (Wilson lower bound)... */
  routeFailShare: 0.2,
  /** ...or as slow as Health calls critical (its latencyCriticalRatio; a test keeps them equal)... */
  latencyRollbackRatio: 2.5,
  /** ...or at least half of all requests slower than the app's usual p95 (Wilson lower bound). */
  appSlowShare: 0.5,
  /** Confidence: at least this many extra failures (or slow requests) behind a rollback. */
  minExcess: 20,

  // Before the deploy.
  /** The previous release must have been normal for this long before the deploy for a rollback. */
  preDeployMs: 30 * MIN,
  /** Without hour-of-week history, compare with the previous release's own last hours (at most this long). */
  fallbackMs: 3 * HOUR,

  // Looks fine.
  fineMinRequests: 200,
  fineMinMs: 30 * MIN,

  // Crash loops after a deploy (fold with Resilience).
  /** The release's first crash must come this soon after the deploy. */
  loopAfterDeployMs: 30 * MIN,
  /** Dependency: a route's recent failures explained by one failing host (Health's foldShare). */
  dependencyShare: 0.5,
  dependencyWindowMs: 30 * MIN,
};
