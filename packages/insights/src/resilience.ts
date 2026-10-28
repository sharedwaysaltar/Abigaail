// The Resilience rules (docs/AGENTS.md agent 4, DECISIONS #111-#114), shared by
// the Resilience agent, Health (which folds its lag and memory findings into
// them) and the dashboard's Runtime view, so all three give the same answer.
// Every function reads only through StoreReader, scoped by app.

import type { LifecycleRow, StoreReader } from "@abigaail/store";
import { topHeapSite } from "./profiles.js";
import { mad, mannKendallZ, median, theilSen, wilsonLower } from "./stats.js";
import { RESILIENCE as R } from "./thresholds.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---- restarts ------------------------------------------------------------------

type Frame = { file: string; line: number; fn?: string };

export type CrashCause =
  /** The crash record named the uncaught error. */
  | { kind: "error"; error_type: string; frame?: Frame; code: number }
  /** The crash record has an exit code and no error. */
  | { kind: "exit"; code: number }
  /** An uncaught error event arrived just before the process went quiet. */
  | { kind: "fatal_error"; error_type: string; frame?: Frame }
  | { kind: "oom"; heap_mb: number; limit_mb: number; site?: string }
  /** No record and no error, but the heap grew steadily until the process stopped. */
  | { kind: "oom_trend"; from_mb: number; to_mb: number; site?: string }
  | { kind: "container_oom"; rss_mb: number; limit_mb: number }
  | { kind: "unknown" };

export interface Crash {
  /** When the replacement process booted. */
  ts: number;
  release: string;
  instance: string | null;
  /** A new instance took over from one that went quiet (it did not restart in place). */
  replaced: boolean;
  cause: CrashCause;
  /** The cause in words, for summaries and the dashboard. */
  text: string;
}

export interface RestartVerdict {
  /** Unexpected restarts in the long loop window, oldest first. */
  crashes: Crash[];
  /** How many of them in the last restartWindowMs. */
  recent: number;
  loop: boolean;
  severity: "warning" | "critical";
}

const at = (f?: Frame) => (f ? ` at ${f.file}:${f.line}` : "");

const siteText = (site?: string) => (site ? `; most of its sampled heap was allocated in ${site}` : "");

/** A crash's cause in words. */
export function causeText(c: CrashCause): string {
  switch (c.kind) {
    case "error":
      return `uncaught ${c.error_type}${at(c.frame)} (exit code ${c.code})`;
    case "exit":
      return `exited with code ${c.code}`;
    case "fatal_error":
      return `uncaught ${c.error_type}${at(c.frame)}`;
    case "oom":
      return `likely out of memory (heap ${Math.round(c.heap_mb)} of ${Math.round(c.limit_mb)} MB)${siteText(c.site)}`;
    case "oom_trend":
      return `likely out of memory: its heap grew from ${Math.round(c.from_mb)} to ${Math.round(c.to_mb)} MB until it stopped${siteText(c.site)}`;
    case "container_oom":
      return `likely killed by the container memory limit (${Math.round(c.rss_mb)} of ${Math.round(c.limit_mb)} MB)`;
    case "unknown":
      return "killed by a signal or the host (Node does not report which)";
  }
}

/** The latest value of `pick` on a ready event at or before `ts`. */
function latestReady(rows: LifecycleRow[], ts: number, pick: (r: LifecycleRow) => number | null): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "ready" && r.ts <= ts && pick(r) !== null) return pick(r)!;
  }
  return undefined;
}

/**
 * Memory just before the process went quiet, projected to that moment from
 * its own trend: the last metric sample can be up to an interval old, and a
 * leaking heap grows fast at the end.
 */
function projectedAt(store: StoreReader, appId: string, name: string, from: number, quiet: number): number | undefined {
  const s = store.metricSeries(appId, name, from, quiet + 1);
  const last = s.at(-1);
  if (!last) return undefined;
  const tail = s.slice(-6);
  const slope = tail.length >= 2 ? theilSen(tail.map((p) => ({ x: p.ts, y: p.value }))) : undefined;
  return slope !== undefined && slope > 0 ? last.value + slope * (quiet - last.ts) : last.value;
}

/**
 * Why the process before `boot` ended, from the strongest evidence there is:
 * the crash record, an uncaught error that got out, then memory near a limit.
 */
export function crashCause(store: StoreReader, appId: string, boot: LifecycleRow, ready: LifecycleRow | undefined, rows: LifecycleRow[], since: number): CrashCause {
  const prev = ready?.prev_exit;
  if (prev?.error_type) return { kind: "error", error_type: prev.error_type, ...(prev.frame ? { frame: prev.frame } : {}), code: prev.code };
  if (prev && prev.code !== 0) return { kind: "exit", code: prev.code };
  // With other instances still sending, "quiet" is close to the boot itself.
  const quiet = store.lastEventBefore(appId, boot.ts)?.ts ?? boot.ts;
  const fatal = store.fatalErrors(appId, quiet - R.fatalWindowMs, boot.ts).at(-1);
  if (fatal) return { kind: "fatal_error", error_type: fatal.error_type, ...(fatal.frame ? { frame: fatal.frame } : {}) };
  const heapLimit = latestReady(rows, boot.ts, (r) => r.heap_limit_mb) ?? ready?.heap_limit_mb ?? undefined;
  const heap = projectedAt(store, appId, "memory_heap_used_mb", since, quiet);
  // With profiling on, the previous process's last heap profile names where its memory went (#120).
  const top = topHeapSite(store, appId, since, quiet + 1);
  const site = top && top.share >= 0.3 ? { site: top.label } : {};
  if (heap !== undefined && heapLimit && heap >= R.oomShare * heapLimit) return { kind: "oom", heap_mb: round1(Math.min(heap, heapLimit)), limit_mb: heapLimit, ...site };
  const memLimit = latestReady(rows, boot.ts, (r) => r.memory_limit_mb) ?? ready?.memory_limit_mb ?? undefined;
  const rss = projectedAt(store, appId, "memory_rss_mb", since, quiet);
  if (rss !== undefined && memLimit && rss >= R.oomShare * memLimit) return { kind: "container_oom", rss_mb: round1(Math.min(rss, memLimit)), limit_mb: memLimit };
  // V8's heap limit includes the young generation (288 MB for --max-old-space-size=96, measured),
  // and a container's OOM killer leaves no trace: a heap that rose steadily to the end is the evidence.
  const life = store.metricSeries(appId, "memory_heap_used_mb", since, quiet + 1).map((p) => p.value);
  const tail = life.slice(-R.oomRiseSamples);
  const low = Math.min(...life);
  if (
    tail.length === R.oomRiseSamples &&
    tail.every((v, i) => i === 0 || v > tail[i - 1]!) &&
    tail.at(-1)! - low >= Math.max(R.oomRiseMb, R.oomRiseShare * low)
  ) {
    return { kind: "oom_trend", from_mb: round1(low), to_mb: round1(tail.at(-1)!), ...site };
  }
  return { kind: "unknown" };
}

/**
 * Unexpected restarts, paired per instance when the SDK sends one (DECISIONS
 * #112): a boot is unexpected when the same instance's previous process sent
 * no shutdown (and its crash record, if any, is not a clean exit), or when it
 * is a new instance that replaced one which went quiet without a shutdown.
 * Instances running side by side never look like restarts. Boots from an SDK
 * without runtime signals keep the per-app rule: the app's previous lifecycle
 * event is not a shutdown. Deploys (a new release) are Health's, never a crash.
 */
export function restartVerdict(store: StoreReader, appId: string, now: number): RestartVerdict | undefined {
  // Crashes before the latest deploy were the replaced release's: a rollback ends them (#133).
  const deployedAt = Math.max(-Infinity, ...store.deploys(appId).map((d) => (d.deployed_at !== null && d.deployed_at <= now ? d.deployed_at : -Infinity)));
  const crashes = unexpectedRestarts(store, appId, now, R.loopLongMs).filter((c) => c.ts > deployedAt);
  const recent = crashes.filter((c) => c.ts >= now - R.restartWindowMs).length;
  if (!recent) return undefined;
  const loop = recent >= R.loopShort || crashes.length >= R.loopLong;
  return { crashes, recent, loop, severity: loop ? "critical" : "warning" };
}

/** Unexpected restarts with ts in (now - windowMs, now], oldest first, with their causes (rules above). */
export function unexpectedRestarts(store: StoreReader, appId: string, now: number, windowMs: number): Crash[] {
  const from = now - windowMs;
  const rows = store.lifecycleDetail(appId, from - R.historyMs, now + 1);
  const readyByBoot = new Map(rows.filter((r) => r.kind === "ready" && r.boot_id).map((r) => [r.boot_id!, r]));
  const capable = rows.some((r) => r.instance !== null);
  const crashes: Crash[] = [];
  let processStart = from - R.historyMs;
  rows.forEach((boot, i) => {
    if (boot.kind !== "boot") return;
    const since = processStart;
    processStart = boot.ts;
    if (boot.ts < from) return;
    const before = store.lastEventBefore(appId, boot.ts);
    // The app's first boot ever, or a deploy (Health's finding).
    if (!before || before.release !== boot.release) return;
    const ready = readyByBoot.get(boot.event_id);
    let unexpected = false;
    let replaced = false;
    if (ready?.instance) {
      const last = rows.slice(0, i).findLast((r) => r.instance === ready.instance);
      if (last) {
        unexpected = last.kind !== "shutdown";
      } else {
        // A new instance id: a scale-out, or a replacement for one that died.
        if (now - boot.ts < R.replaceWaitMs) return;
        const lastOf = new Map<string, LifecycleRow>();
        for (const r of rows.slice(0, i)) if (r.instance) lastOf.set(r.instance, r);
        replaced = [...lastOf].some(
          ([id, r]) => r.kind !== "shutdown" && boot.ts - r.ts <= R.replaceWithinMs && !rows.some((x) => x.instance === id && x.ts > boot.ts),
        );
        unexpected = replaced;
      }
      // Exited normally without calling shutdown(): not a crash.
      if (ready.prev_exit?.code === 0 && !replaced) unexpected = false;
    } else {
      // Its ready (with the instance) may still be on its way.
      if (capable && now - boot.ts < R.readyWaitMs) return;
      unexpected = i > 0 && rows[i - 1]!.kind !== "shutdown";
    }
    if (!unexpected) return;
    const cause = crashCause(store, appId, boot, ready, rows, since);
    crashes.push({ ts: boot.ts, release: boot.release, instance: ready?.instance ?? null, replaced, cause, text: causeText(cause) });
  });
  return crashes;
}

// ---- leaks ---------------------------------------------------------------------

export type LeakKind = "heap" | "external" | "rss";

export interface LeakVerdict {
  kind: LeakKind;
  /** Rising: significant trend and enough growth. */
  rising: boolean;
  z: number;
  buckets: number;
  first_mb: number;
  last_mb: number;
  growth_mb: number;
  /** Theil-Sen slope of the floor. */
  mb_per_hour: number;
  span_ms: number;
  boot_ts: number;
  limit_mb: number | null;
  /** When the trend reaches the limit, if it does. */
  hours_to_limit: number | null;
  severity: "warning" | "critical";
}

const LEAK_METRIC: Record<LeakKind, string> = { heap: "heap_floor_mb", external: "memory_external_mb", rss: "memory_rss_mb" };

/** The lowest reading in each bucket: what is still there after the garbage is gone. */
function floors(series: { ts: number; value: number }[], from: number, bucketMs: number): { x: number; y: number }[] {
  const byBucket = new Map<number, number>();
  for (const p of series) {
    const b = Math.floor((p.ts - from) / bucketMs);
    const cur = byBucket.get(b);
    if (cur === undefined || p.value < cur) byBucket.set(b, p.value);
  }
  return [...byBucket].sort((a, b) => a[0] - b[0]).map(([b, y]) => ({ x: from + (b + 0.5) * bucketMs, y }));
}

/**
 * Leak = a rising floor within the latest process's life (a restart resets
 * it), after a warm-up: the post-GC heap floor (JS objects), external memory
 * (Buffers, ArrayBuffers) and RSS (native memory, judged only while the heap
 * floor is flat, so a JS leak is not reported twice). Needs runtime signals:
 * without a heap floor nothing is judged, and Health's RSS rule stands.
 */
export function leakVerdicts(store: StoreReader, appId: string, now: number): LeakVerdict[] {
  const boot = store.lastBoot(appId);
  if (!boot) return [];
  const from = Math.max(boot.ts + R.warmupMs, now - R.maxSpanMs);
  if (now - from < R.minSpanMs) return [];
  const ready = store.lifecycleDetail(appId, boot.ts, now + 1).find((r) => r.kind === "ready");
  const judge = (kind: LeakKind): LeakVerdict | undefined => {
    const points = floors(store.metricSeries(appId, LEAK_METRIC[kind], from, now), from, R.bucketMs);
    if (points.length < R.minBuckets) return undefined;
    const ys = points.map((p) => p.y);
    const z = mannKendallZ(ys);
    const first = median(ys.slice(0, 2))!;
    const last = median(ys.slice(-2))!;
    const growth = last - first;
    const slope = (theilSen(points.map((p) => ({ x: p.x / HOUR, y: p.y }))) ?? 0);
    const limit = (kind === "heap" ? ready?.heap_limit_mb : ready?.memory_limit_mb) ?? null;
    const hours = limit !== null && slope > 0 ? Math.max(0, (limit - last) / slope) : null;
    const rising = z >= R.trendZ && growth >= Math.max(R.minGrowthShare * first, R.minGrowthMb);
    return {
      kind,
      rising,
      z: Math.round(z * 100) / 100,
      buckets: points.length,
      first_mb: round1(first),
      last_mb: round1(last),
      growth_mb: round1(growth),
      mb_per_hour: round1(slope),
      span_ms: now - from,
      boot_ts: boot.ts,
      limit_mb: limit,
      hours_to_limit: hours === null ? null : round1(hours),
      severity: hours !== null && hours * HOUR <= R.criticalWithinMs ? "critical" : "warning",
    };
  };
  const heap = judge("heap");
  if (!heap) return [];
  const external = judge("external");
  const out = [heap, external].filter((v): v is LeakVerdict => v?.rising === true);
  if (!out.length) {
    const rss = judge("rss");
    if (rss?.rising) out.push(rss);
  }
  return out;
}

// ---- event-loop blocks -------------------------------------------------------

export interface BlockingRoute {
  route: string;
  /** Blocks charged to it in the window, and all distinct blocks in the app. */
  blocks: number;
  all_blocks: number;
  share: number;
  share_lower: number;
  blocked_ms: number;
  max_ms: number;
  /** The last criticalWindowMs. */
  recent_blocks: number;
  recent_blocked_ms: number;
  severity: "warning" | "critical";
}

/**
 * Routes that block the event loop: charged for at least minBlocks blocks,
 * most of all blocks (Wilson lower bound), and at least minBlockedMs of
 * blocked time in the window. The SDK charges the request that ran through a
 * block (runtime.ts), so this names the cause rather than whatever was slow at
 * the same time. Sorted worst first.
 */
export function blockingRoutes(store: StoreReader, appId: string, end: number): BlockingRoute[] {
  const from = end - R.blockWindowMs;
  const rows = store.blocks(appId, from, end);
  if (!rows.length) return [];
  const recentFrom = end - R.criticalWindowMs;
  const counted = store.metricSeries(appId, "event_loop_blocks", from, end).reduce((s, p) => s + p.value, 0);
  const byRoute = new Map<string, { blocks: number; ms: number; max: number; rBlocks: number; rMs: number }>();
  for (const r of rows) {
    if (r.route === null) continue;
    let a = byRoute.get(r.route);
    if (!a) byRoute.set(r.route, (a = { blocks: 0, ms: 0, max: 0, rBlocks: 0, rMs: 0 }));
    a.blocks += r.count;
    a.ms += r.total_ms;
    a.max = Math.max(a.max, r.max_ms);
    if (r.ts >= recentFrom) {
      a.rBlocks += r.count;
      a.rMs += r.total_ms;
    }
  }
  // The SDK counts distinct blocks; without that count, the most any route was charged.
  const fallback = Math.max(0, ...[...byRoute.values()].map((a) => a.blocks), rows.filter((r) => r.route === null).reduce((s, r) => s + r.count, 0));
  const all = Math.max(counted, fallback);
  const out: BlockingRoute[] = [];
  for (const [route, a] of byRoute) {
    const lower = wilsonLower(a.blocks, Math.max(all, a.blocks));
    if (a.blocks < R.minBlocks || lower < R.minBlockShare || a.ms < R.minBlockedMs) continue;
    const critical = a.rBlocks >= R.criticalBlocks && a.rMs / a.rBlocks >= R.criticalAvgMs;
    out.push({
      route,
      blocks: a.blocks,
      all_blocks: all,
      share: Math.round((a.blocks / Math.max(all, a.blocks)) * 100) / 100,
      share_lower: Math.round(lower * 100) / 100,
      blocked_ms: Math.round(a.ms),
      max_ms: Math.round(a.max),
      recent_blocks: a.rBlocks,
      recent_blocked_ms: Math.round(a.rMs),
      severity: critical ? "critical" : "warning",
    });
  }
  return out.sort((x, y) => y.blocked_ms - x.blocked_ms);
}

// ---- cold start --------------------------------------------------------------

export interface StartupVerdict {
  /** When the process said it was ready. */
  ts: number;
  release: string;
  startup_ms: number;
  /** Median and MAD of earlier startups, if there are enough. */
  normal_ms: number | null;
  mad_ms: number | null;
  history: number;
  slow: boolean;
}

/**
 * The latest start's cost (process start until the first server listened)
 * against the app's earlier starts, for coldShowMs after it.
 */
export function startupVerdict(store: StoreReader, appId: string, now: number): StartupVerdict | undefined {
  const latest = store.startups(appId, now - R.coldShowMs, now + 1, 1)[0];
  if (!latest) return undefined;
  const history = store.startups(appId, now - 30 * 24 * HOUR, latest.ts, R.startupHistory).map((r) => r.startup_ms);
  const enough = history.length >= R.startupMinHistory;
  const normal = enough ? median(history)! : null;
  const spread = enough ? mad(history)! : null;
  const x = latest.startup_ms;
  const slow =
    normal !== null && spread !== null
      ? x >= R.startupRatio * normal && x >= R.startupFloorMs && x >= normal + R.startupMads * 1.4826 * spread
      : x >= R.startupNoBaselineMs;
  return { ts: latest.ts, release: latest.release, startup_ms: x, normal_ms: normal, mad_ms: spread, history: history.length, slow };
}
