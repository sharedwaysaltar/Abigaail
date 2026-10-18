// An app's own normal (docs/AGENTS.md principle 1): the same key at the same
// hour of the week over recent weeks, read from the hourly rollup only.

import { HOUR_MS, type StatKind, type StatRow, type StoreReader } from "@abigaail/store";
import { mad, median } from "./stats.js";
import { BASELINE as B } from "./thresholds.js";

const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export type BaselineSource = "hour-of-week" | "daily" | "none";

export interface Slots {
  source: BaselineSource;
  /** Past hours with data (rolled up, and the app sent events in them). */
  hours: number[];
}

/**
 * The past hours that define normal for the hour containing `at`: the same
 * hour-of-week over the last 4 weeks when at least 2 have data, otherwise the
 * same hour on the last 7 days when at least 2 have data, otherwise none.
 * An hour in which the app sent nothing at all is "no data", not "zero traffic".
 */
export function baselineSlots(store: StoreReader, appId: string, at: number): Slots {
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  const weekly = Array.from({ length: B.weeks }, (_, k) => hour - (k + 1) * WEEK_MS);
  const daily = Array.from({ length: B.days }, (_, d) => hour - (d + 1) * DAY_MS);
  const rolled = store.rolledHours(appId, [...weekly, ...daily]);
  const withData = (hours: number[]) => hours.filter((h) => (rolled.get(h) ?? 0) > 0);
  const w = withData(weekly);
  if (w.length >= B.minWeeks) return { source: "hour-of-week", hours: w };
  const d = withData(daily);
  if (d.length >= B.minDays) return { source: "daily", hours: d };
  return { source: "none", hours: [] };
}

/** Rollup rows per key, aligned with slots.hours; undefined = the key had no traffic in that slot. */
export function rowsByKey(store: StoreReader, appId: string, kind: StatKind, slots: Slots): Map<string, (StatRow | undefined)[]> {
  const index = new Map(slots.hours.map((h, i) => [h, i]));
  const out = new Map<string, (StatRow | undefined)[]>();
  for (const row of store.hourly(appId, kind, slots.hours)) {
    let list = out.get(row.key);
    if (!list) out.set(row.key, (list = new Array<StatRow | undefined>(slots.hours.length).fill(undefined)));
    list[index.get(row.hour)!] = row;
  }
  return out;
}

/** Per slot, the total over every key of `kind` (e.g. all requests that matter). */
export function totals(store: StoreReader, appId: string, kind: StatKind, slots: Slots): { n: number; weighted_n: number }[] {
  const sums = slots.hours.map(() => ({ n: 0, weighted_n: 0 }));
  const index = new Map(slots.hours.map((h, i) => [h, i]));
  for (const row of store.hourly(appId, kind, slots.hours)) {
    const t = sums[index.get(row.hour)!]!;
    t.n += row.n;
    t.weighted_n += row.weighted_n;
  }
  return sums;
}

/** Typical hourly count: median over slots, a missing row counting as 0. */
export function typicalCount(rows: readonly (StatRow | undefined)[] | undefined, weighted = false): number {
  if (!rows?.length) return 0;
  return median(rows.map((r) => (r ? (weighted ? r.weighted_n : r.n) : 0))) ?? 0;
}

/** Typical share (e.g. 5xx / requests) over slots that had traffic; undefined without any. */
export function typicalRate(
  rows: readonly (StatRow | undefined)[] | undefined,
  part: (r: StatRow) => number,
): number | undefined {
  const rates = (rows ?? []).filter((r): r is StatRow => !!r && r.n > 0).map((r) => part(r) / r.n);
  return median(rates);
}

/** Typical p95 and its spread over slots with enough requests; undefined if too few slots. */
export function typicalP95(
  rows: readonly (StatRow | undefined)[] | undefined,
  minRequests = B.minSlotRequests,
): { median: number; mad: number; slots: number } | undefined {
  const values = (rows ?? [])
    .filter((r): r is StatRow => !!r && r.n >= minRequests && r.p95 !== null)
    .map((r) => r.p95!);
  if (values.length < B.minLatencySlots) return undefined;
  return { median: median(values)!, mad: mad(values)!, slots: values.length };
}

/** Typical metric level (median of hourly medians). */
export function typicalLevel(rows: readonly (StatRow | undefined)[] | undefined): number | undefined {
  const values = (rows ?? []).filter((r): r is StatRow => !!r && r.p50 !== null).map((r) => r.p50!);
  return values.length >= B.minLatencySlots ? median(values) : undefined;
}
