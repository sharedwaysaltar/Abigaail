// Shared arithmetic for agents. Rules and statistics only, no ML.

export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median absolute deviation: a spread that one outlier week cannot inflate. */
export function mad(values: readonly number[]): number | undefined {
  const m = median(values);
  if (m === undefined) return undefined;
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * Wilson score lower bound for a proportion (z = 1.96: 95%). With few trials
 * it stays low, so 1 failure in 2 requests is not "50% errors".
 */
export function wilsonLower(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

/** P(X <= k) for X ~ Poisson(lambda): how surprising a low count is. */
export function poissonCdf(k: number, lambda: number): number {
  if (lambda <= 0) return 1;
  if (k < 0) return 0;
  // Summed in log space: exp(-lambda) alone underflows to 0 above lambda ~745.
  let logTerm = -lambda;
  let logSum = logTerm;
  for (let i = 1; i <= Math.floor(k); i++) {
    logTerm += Math.log(lambda / i);
    const hi = Math.max(logSum, logTerm);
    logSum = hi + Math.log(Math.exp(logSum - hi) + Math.exp(logTerm - hi));
  }
  return Math.min(1, Math.exp(logSum));
}

/** P(X >= k) for X ~ Poisson(lambda): how surprising a high count is. */
export function poissonUpperTail(k: number, lambda: number): number {
  return k <= 0 ? 1 : 1 - poissonCdf(k - 1, lambda);
}

/** "3 min", "2 h 5 min", "45 s": durations for summaries. */
export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
