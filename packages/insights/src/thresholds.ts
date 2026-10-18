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
};
