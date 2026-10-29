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

/** ln Γ(x) for x > 0 (Lanczos, g = 7): about 15 significant digits. */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const z = x - 1;
  let a = c[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ln P(X = k) for X ~ Binomial(n, p). */
function logBinomPmf(k: number, n: number, p: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log1p(-p);
}

/**
 * P(X >= k) for X ~ Binomial(n, p), exact: how surprising k failures in n
 * requests are when the usual failure share is p. Summed from the smaller
 * tail, in log space, stopping once the terms no longer matter.
 */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const sumFrom = (from: number, to: number, step: 1 | -1): number => {
    const first = logBinomPmf(from, n, p);
    let total = 0;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const term = Math.exp(logBinomPmf(i, n, p) - first);
      total += term;
      if (term < 1e-17 * total) break;
    }
    return Math.exp(first + Math.log(total));
  };
  // Above the mean the upper tail's terms fall away from k; below it, sum the lower tail instead.
  if (k > n * p) return Math.min(1, sumFrom(k, n, 1));
  return Math.max(0, 1 - sumFrom(k - 1, 0, -1));
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

/**
 * Mann-Kendall trend test: z for "these values rise over time" (one-sided;
 * z > 2.326 is p < 0.01). It looks only at the order of pairs, so a sawtooth or
 * one outlier cannot fake a trend. Ties count as neither up nor down.
 */
export function mannKendallZ(values: readonly number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(values[j]! - values[i]!);
  }
  const variance = (n * (n - 1) * (2 * n + 5)) / 18;
  if (s === 0) return 0;
  return (s - Math.sign(s)) / Math.sqrt(variance);
}

/** Theil-Sen slope: the median of all pairwise slopes, robust to outliers. */
export function theilSen(points: readonly { x: number; y: number }[]): number | undefined {
  const slopes: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]!.x - points[i]!.x;
      if (dx !== 0) slopes.push((points[j]!.y - points[i]!.y) / dx);
    }
  }
  return median(slopes);
}
