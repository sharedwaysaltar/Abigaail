// Health (agent 2): is each app working right now, judged against its own
// normal (docs/AGENTS.md). Runs every minute over 1/5/15-minute windows ending
// EVAL_LAG_MS before now. Counts only traffic that matters (DECISIONS #37),
// needs a minimum of evidence and a statistical bound before it speaks, and
// names a cause when a failing dependency explains a failing route.

import { HOUR_MS, type App, type Severity, type StatRow } from "@abigaail/store";
import {
  baselineSlots,
  humanDuration,
  median,
  poissonCdf,
  rowsByKey,
  totals,
  typicalCount,
  typicalLevel,
  typicalP95,
  typicalRate,
  wilsonLower,
  type Slots,
} from "@abigaail/insights";
import { HEALTH as H, SCHEDULE, WATCHDOG } from "./thresholds.js";
import type { Agent, AgentContext, AgentFinding } from "./types.js";

const MIN = 60_000;
const DAY_MS = 24 * HOUR_MS;
const RANK: Record<Severity, number> = { critical: 3, warning: 2, unknown: 1, info: 0 };
const worse = (a: Severity, b: Severity): Severity => (RANK[a] >= RANK[b] ? a : b);
const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "for Tuesday 14:00 UTC", "for this hour on recent days", or "" (no baseline). */
function normalFor(slots: Slots, at: number): string {
  const d = new Date(at);
  if (slots.source === "hour-of-week") return ` for ${DAYS[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
  if (slots.source === "daily") return " for this hour on recent days";
  return "";
}

interface Windows {
  end: number;
  routes5: Map<string, StatRow>;
  routes15: Map<string, StatRow>;
}

const byKey = (rows: StatRow[]) => new Map(rows.map((r) => [r.key, r]));

// ---- 1. restarts and deploys ---------------------------------------------------

/**
 * A boot on a new release is a deploy (info). A boot on the same release with
 * no shutdown before it is a crash or kill (warning). The release comes from
 * the app's last event of any type before the boot.
 */
function restarts(ctx: AgentContext, app: App): AgentFinding[] {
  const events = ctx.store.lifecycle(app.id, ctx.now - DAY_MS, ctx.now + 1);
  const crashes: number[] = [];
  const out: AgentFinding[] = [];
  events.forEach((e, i) => {
    if (e.kind !== "boot" || e.ts < ctx.now - 15 * MIN) return;
    const previous = ctx.store.releaseBefore(app.id, e.ts);
    if (previous === undefined) return; // the app's first boot ever
    if (previous !== e.release) {
      out.push({
        signal: "deploy",
        subject: e.release,
        severity: "info",
        summary: `${app.name} deployed release ${e.release} (was ${previous}) at ${new Date(e.ts).toISOString().slice(11, 16)} UTC.`,
        action: "Nothing to do. Health compares the new release with the app's normal; watch for findings in the next minutes.",
        evidence: { release: e.release, previous_release: previous, booted_at: e.ts },
        fact: true,
      });
      return;
    }
    // Same release, and the previous lifecycle event is not a shutdown: crash or kill.
    if (i > 0 && events[i - 1]!.kind !== "shutdown") crashes.push(e.ts);
  });
  if (!crashes.length) return out;
  return [...out, {
    signal: "restart",
    subject: "",
    severity: "warning",
    summary: `${app.name} restarted ${crashes.length === 1 ? "once" : `${crashes.length} times`} in the last 15 min without a clean shutdown.`,
    cause: "The process crashed or was killed (out of memory, an unhandled error, or the host restarting it).",
    action: "Check the app's own logs around the restart time for a fatal error or an OOM kill.",
    evidence: { boots_without_shutdown: crashes, window_ms: 15 * MIN },
  }];
}

// ---- 2/3. routes: 5xx, auth failures, latency --------------------------------

interface RouteFailure {
  route: string;
  windowMs: number;
  row: StatRow;
  finding: AgentFinding;
}

function judgeErrors(row: StatRow, base: number | undefined): { severity: Severity; lb: number } | undefined {
  if (row.status_5xx < H.minFailures) return undefined;
  const lb = wilsonLower(row.status_5xx, row.n);
  if (base === undefined) {
    if (lb >= H.errorCritical) return { severity: "critical", lb };
    if (lb >= H.errorWarnNoBaseline) return { severity: "warning", lb };
    return undefined;
  }
  if (lb >= Math.max(H.errorCritical, H.errorWarnFactor * base)) return { severity: "critical", lb };
  if (lb >= Math.max(H.errorWarnFloor, H.errorWarnFactor * base)) return { severity: "warning", lb };
  return undefined;
}

function routeErrors(app: App, w: Windows, slots: Slots, base: Map<string, (StatRow | undefined)[]>): RouteFailure[] {
  const out: RouteFailure[] = [];
  for (const [route, row15] of w.routes15) {
    const rate = typicalRate(base.get(route), (r) => r.status_5xx);
    // The 5-minute window speaks first; the 15-minute one adds evidence on low traffic.
    let best: { windowMs: number; row: StatRow; severity: Severity; lb: number } | undefined;
    for (const [windowMs, row] of [[5 * MIN, w.routes5.get(route)], [15 * MIN, row15]] as const) {
      if (!row) continue;
      const j = judgeErrors(row, rate);
      if (j && (!best || RANK[j.severity] > RANK[best.severity])) best = { windowMs, row, ...j };
    }
    if (!best) continue;
    const { row, windowMs, severity, lb } = best;
    const share = row.status_5xx / row.n;
    const sampled = row.weighted_n > row.n;
    out.push({
      route,
      windowMs,
      row,
      finding: {
        signal: "server_errors",
        subject: route,
        severity,
        summary:
          `${route} returns 5xx for ${pct(share)} of requests (${row.status_5xx} of ${row.n} in the last ${humanDuration(windowMs)})` +
          (rate === undefined ? "; no baseline yet." : `, usually ${pct(rate)}${normalFor(slots, w.end)}.`),
        action: "Check the app's logs and recent deploys for errors on this route.",
        evidence: {
          route,
          window_ms: windowMs,
          requests: row.n,
          failures: row.status_5xx,
          share,
          wilson_lower: lb,
          ...(sampled ? { estimated_failures: Math.round(share * row.weighted_n), estimated_requests: Math.round(row.weighted_n) } : {}),
          baseline: slots.source,
          baseline_share: rate ?? null,
        },
      },
    });
  }
  return out;
}

function authFailures(w: Windows, slots: Slots, base: Map<string, (StatRow | undefined)[]>): AgentFinding[] {
  const out: AgentFinding[] = [];
  for (const [route, row] of w.routes15) {
    if (row.status_401_403 < H.minAuthFailures) continue;
    const lb = wilsonLower(row.status_401_403, row.n);
    const rate = typicalRate(base.get(route), (r) => r.status_401_403);
    const fires = rate === undefined ? lb >= H.authWarnNoBaseline : lb >= Math.max(H.errorWarnFloor, H.authWarnFactor * rate);
    if (!fires) continue;
    out.push({
      signal: "auth_failures",
      subject: route,
      severity: "warning",
      summary:
        `${route} refuses ${pct(row.status_401_403 / row.n)} of requests with 401/403 (${row.status_401_403} of ${row.n} in 15 min)` +
        (rate === undefined ? "; no baseline yet." : `, usually ${pct(rate)}${normalFor(slots, w.end)}.`),
      cause: "A login or permission problem, not an outage: sessions expiring, a broken auth provider, or a client sending bad credentials.",
      action: "Check the auth flow on this route; if one client causes it, the Bots & Abuse agent will separate brute force from real users.",
      evidence: { route, window_ms: 15 * MIN, requests: row.n, refused: row.status_401_403, wilson_lower: lb, baseline: slots.source, baseline_share: rate ?? null },
    });
  }
  return out;
}

interface LatencyJudgement {
  severity: Severity;
  p95: number;
  normal?: { median: number; mad: number; slots: number };
}

function judgeLatency(p95: number, normal: LatencyJudgement["normal"]): LatencyJudgement | undefined {
  if (!normal) return p95 >= H.latencyNoBaselineMs ? { severity: "warning", p95 } : undefined;
  const ratio = p95 / normal.median;
  if (p95 - normal.median < H.latencyFloorMs || p95 <= normal.median + H.latencyMads * normal.mad) return undefined;
  if (ratio >= H.latencyCriticalRatio) return { severity: "critical", p95, normal };
  if (ratio >= H.latencyWarnRatio) return { severity: "warning", p95, normal };
  return undefined;
}

function routeLatency(w: Windows, slots: Slots, base: Map<string, (StatRow | undefined)[]>): { route: string; finding: AgentFinding }[] {
  const out: { route: string; finding: AgentFinding }[] = [];
  for (const [route, row] of w.routes5) {
    if (row.n < H.minLatencyRequests || row.p95 === null) continue;
    const j = judgeLatency(row.p95, typicalP95(base.get(route)));
    if (!j) continue;
    out.push({
      route,
      finding: {
        signal: "latency",
        subject: route,
        severity: j.severity,
        summary: j.normal
          ? `${route} p95 is ${ms(j.p95)}, ${(j.p95 / j.normal.median).toFixed(1)}× its usual ${ms(j.normal.median)}${normalFor(slots, w.end)}; ${row.n} requests in 5 min.`
          : `${route} p95 is ${ms(j.p95)} over ${row.n} requests in 5 min; no baseline yet.`,
        action: "Look for a slow dependency or a recent deploy touching this route.",
        evidence: {
          route,
          window_ms: 5 * MIN,
          requests: row.n,
          p50: row.p50,
          p95: row.p95,
          p99: row.p99,
          baseline: j.normal ? slots.source : "none",
          baseline_p95: j.normal?.median ?? null,
          baseline_mad: j.normal?.mad ?? null,
        },
      },
    });
  }
  return out;
}

// ---- 5. dependencies -----------------------------------------------------------

interface Dependency {
  host: string;
  severity: Severity;
  row: StatRow;
  failing?: { lb: number; share: number; base: number | undefined };
  slow?: LatencyJudgement;
  /** Routes whose 5xx this host explains (folded route findings). */
  explains: { route: string; failing_requests: number; failures: number; window_ms: number }[];
}

function dependencies(ctx: AgentContext, app: App, w: Windows, slots: Slots): Map<string, Dependency> {
  const base = rowsByKey(ctx.store, app.id, "host", slots);
  const deps = new Map<string, Dependency>();
  for (const row of ctx.store.statsFor(app.id, "host", w.end - 5 * MIN, w.end)) {
    const dep: Dependency = { host: row.key, severity: "info", row, explains: [] };
    if (row.n >= H.minCalls && row.failures > 0) {
      const lb = wilsonLower(row.failures, row.n);
      const rate = typicalRate(base.get(row.key), (r) => r.failures);
      let severity: Severity | undefined;
      if (rate === undefined) severity = lb >= H.depWarnNoBaseline ? "warning" : undefined;
      else if (lb >= Math.max(H.depCritical, H.depWarnFactor * rate)) severity = "critical";
      else if (lb >= Math.max(H.depWarnFloor, H.depWarnFactor * rate)) severity = "warning";
      if (severity) {
        dep.failing = { lb, share: row.failures / row.n, base: rate };
        dep.severity = worse(dep.severity, severity);
      }
    }
    if (row.n >= H.minLatencyCalls && row.p95 !== null) {
      const j = judgeLatency(row.p95, typicalP95(base.get(row.key), 3));
      if (j) {
        dep.slow = j;
        dep.severity = worse(dep.severity, j.severity);
      }
    }
    deps.set(row.key, dep);
  }
  return deps;
}

function dependencyFinding(dep: Dependency, linked: { route: string | null; calls: number; failed: number }[], slots: Slots, end: number): AgentFinding {
  const { host, row } = dep;
  const parts: string[] = [];
  if (dep.failing) {
    parts.push(`${host} is failing: ${row.failures} of ${row.n} calls in 5 min ended in an error, timeout or 5xx` +
      (dep.failing.base === undefined ? "" : ` (usually ${pct(dep.failing.base)})`));
  }
  if (dep.slow) {
    parts.push(dep.slow.normal
      ? `${host} p95 rose to ${ms(dep.slow.p95)} from its usual ${ms(dep.slow.normal.median)}${normalFor(slots, end)}`
      : `${host} p95 is ${ms(dep.slow.p95)}; no baseline yet`);
  }
  if (!parts.length) parts.push(`${host} explains failing requests`);
  const routes = dep.explains.map((e) => e.route);
  const summary = parts.join("; ") + (routes.length ? `, so ${routes.join(", ")} ${routes.length === 1 ? "fails" : "fail"}.` : ".");
  return {
    signal: "dependency",
    subject: host,
    severity: dep.severity,
    summary,
    cause: `The outbound dependency ${host}.`,
    action: `Check ${host}'s status page; consider a shorter timeout with a fallback so callers fail fast.`,
    evidence: {
      host,
      window_ms: 5 * MIN,
      calls: row.n,
      failed_calls: row.failures,
      p50: row.p50,
      p95: row.p95,
      wilson_lower: dep.failing?.lb ?? null,
      baseline: slots.source,
      baseline_failure_share: dep.failing?.base ?? null,
      baseline_p95: dep.slow?.normal?.median ?? null,
      explains_routes: dep.explains,
      called_from: linked.map((l) => ({ route: l.route ?? "(unlinked)", calls: l.calls, failed: l.failed })),
    },
  };
}

// ---- 4. saturation ---------------------------------------------------------------

function saturation(ctx: AgentContext, app: App, w: Windows, slots: Slots): AgentFinding[] {
  const out: AgentFinding[] = [];
  const series = (name: string, windowMs: number) =>
    ctx.store.metricSeries(app.id, name, w.end - windowMs, w.end).map((s) => s.value);

  const lag = series("event_loop_lag_p99_ms", 5 * MIN);
  const lagLevel = median(lag);
  if (lag.length >= H.minLagSamples && lagLevel !== undefined && lagLevel >= H.lagWarnMs) {
    // One blocked route freezes all of them: name the slowest in the same window.
    const slowest = [...w.routes5.values()]
      .filter((r) => r.p95 !== null)
      .sort((a, b) => b.p95! - a.p95!)
      .slice(0, H.slowestRoutes);
    out.push({
      signal: "event_loop_lag",
      subject: "",
      severity: lagLevel >= H.lagCriticalMs ? "critical" : "warning",
      summary: `${app.name}'s event loop is blocked: lag p99 ${ms(lagLevel)} over the last 5 min` +
        (slowest.length ? `; slowest routes: ${slowest.map((r) => `${r.key} (p95 ${ms(r.p95!)})`).join(", ")}.` : "."),
      cause: slowest.length ? `Likely synchronous work in ${slowest[0]!.key}.` : "Synchronous work (CPU-heavy code, sync I/O, large JSON) blocking the event loop.",
      action: "Profile the slowest route; move heavy work off the main thread or make it asynchronous.",
      evidence: { window_ms: 5 * MIN, lag_p99_ms: lagLevel, samples: lag.length, slowest_routes: slowest.map((r) => ({ route: r.key, p95: r.p95, requests: r.n })) },
    });
  }

  const metricBase = rowsByKey(ctx.store, app.id, "metric", slots);
  const rss = series("memory_rss_mb", 15 * MIN);
  const rssLevel = median(rss);
  const rssNormal = typicalLevel(metricBase.get("memory_rss_mb"));
  if (rss.length >= H.minResourceSamples && rssLevel !== undefined && rssNormal !== undefined && rssLevel >= H.rssWarnRatio * rssNormal) {
    out.push({
      signal: "memory",
      subject: "",
      severity: "warning",
      summary: `${app.name} uses ${Math.round(rssLevel)} MB of memory, ${(rssLevel / rssNormal).toFixed(1)}× its usual ${Math.round(rssNormal)} MB${normalFor(slots, w.end)}.`,
      action: "Check for a leak or an unusually large cache; the Resilience agent (Phase 2) will track the post-GC floor.",
      evidence: { window_ms: 15 * MIN, rss_mb: rssLevel, baseline_rss_mb: rssNormal, baseline: slots.source },
    });
  }

  const cpu = series("cpu_percent", 15 * MIN);
  const cpuLevel = median(cpu);
  if (cpu.length >= H.minResourceSamples && cpuLevel !== undefined && cpuLevel >= H.cpuWarnPercent) {
    out.push({
      signal: "cpu",
      subject: "",
      severity: "warning",
      summary: `${app.name} has used ${Math.round(cpuLevel)}% CPU for the last 15 min.`,
      action: "Look for a hot loop or a traffic spike; scale out if the load is real.",
      evidence: { window_ms: 15 * MIN, cpu_percent: cpuLevel, samples: cpu.length },
    });
  }
  return out;
}

// ---- 6. traffic collapse ---------------------------------------------------------

function trafficCollapse(ctx: AgentContext, app: App, w: Windows, slots: Slots): AgentFinding[] {
  if (slots.source === "none") return [];
  const observed = [...w.routes15.values()].reduce((s, r) => s + r.weighted_n, 0);
  const expected = (median(totals(ctx.store, app.id, "route", slots).map((t) => t.weighted_n)) ?? 0) / 4;
  if (expected < H.collapseMinExpected || observed > H.collapseShare * expected) return [];
  if (poissonCdf(Math.floor(observed), expected) >= H.collapseP) return [];
  // Only "up but nobody gets through": a dead process is the Watchdog's finding.
  const beats = ctx.store.lifecycle(app.id, ctx.now - WATCHDOG.silentMinMs, ctx.now + 1);
  if (!beats.some((b) => b.kind === "heartbeat" || b.kind === "boot")) return [];
  return [{
    signal: "traffic_collapse",
    subject: "",
    severity: "critical",
    summary: `${app.name} is up but traffic collapsed: ${Math.round(observed)} requests in 15 min against ${Math.round(expected)} usually${normalFor(slots, w.end)}.`,
    cause: "Heartbeats still arrive, so the process runs but requests do not reach it: a proxy, DNS, TLS or routing problem in front of the app.",
    action: "Open the app from outside; check the reverse proxy, DNS records and certificate.",
    evidence: { window_ms: 15 * MIN, observed, expected, baseline: slots.source },
  }];
}

// ---- 7. new error bursts -----------------------------------------------------------

function errorBursts(ctx: AgentContext, app: App, w: Windows, slots: Slots): AgentFinding[] {
  const errors = ctx.store.statsFor(app.id, "error", w.end - 15 * MIN, w.end).filter((e) => e.n >= H.minNewErrors);
  if (!errors.length) return [];
  const histFrom = w.end - H.errorHistoryMs;
  const thisHour = Math.floor(w.end / HOUR_MS) * HOUR_MS;
  const histHours: number[] = [];
  for (let h = Math.ceil(histFrom / HOUR_MS) * HOUR_MS; h < thisHour; h += HOUR_MS) histHours.push(h);
  const hasHistory = [...ctx.store.rolledHours(app.id, histHours).values()].some((n) => n > 0);
  const seen = ctx.store.hourlyKeys(app.id, "error", histFrom, thisHour);
  const base = rowsByKey(ctx.store, app.id, "error", slots);
  const out: AgentFinding[] = [];
  for (const e of errors) {
    const [type, route] = e.key.split(" ");
    const where = route && route !== "-" ? ` on ${route}` : "";
    const evidence = { error: e.key, count: e.n, window_ms: 15 * MIN };
    if (!hasHistory || !seen.has(e.key)) {
      out.push({
        signal: "new_error",
        subject: e.key,
        severity: "warning",
        summary: hasHistory
          ? `New error: ${type}${where}, ${e.n} times in 15 min, not seen in the last 7 days.`
          : `${type}${where} occurred ${e.n} times in 15 min; no error history yet to compare with.`,
        cause: "Often the first sign of a bad code path, typically after a deploy.",
        action: "Check the stack frames in the error events and what changed recently.",
        evidence: { ...evidence, history: hasHistory },
      });
      continue;
    }
    const normal = typicalCount(base.get(e.key)) / 4;
    if (e.n >= Math.max(H.minNewErrors, H.errorBurstFactor * Math.max(normal, 1))) {
      out.push({
        signal: "error_burst",
        subject: e.key,
        severity: "warning",
        summary: `${type}${where} occurred ${e.n} times in 15 min, about ${normal < 1 ? "<1" : Math.round(normal)} usually${normalFor(slots, w.end)}.`,
        action: "Check the stack frames in the error events and what changed recently.",
        evidence: { ...evidence, usual_per_15_min: normal, baseline: slots.source },
      });
    }
  }
  return out;
}

// ---- 8. data trust ---------------------------------------------------------------------

function dataTrust(ctx: AgentContext, app: App, w: Windows): AgentFinding[] {
  const reasons: string[] = [];
  const evidence: Record<string, unknown> = { window_ms: 15 * MIN };
  const dropped = ctx.store.metricSeries(app.id, "sdk_dropped_events", w.end - 15 * MIN, w.end).map((s) => s.value);
  // The counter is cumulative per process; sum the increases (a restart resets it).
  let newlyDropped = 0;
  for (let i = 1; i < dropped.length; i++) newlyDropped += Math.max(0, dropped[i]! - dropped[i - 1]!);
  if (newlyDropped > 0) {
    reasons.push(`the SDK dropped ${newlyDropped} events`);
    evidence.sdk_dropped = newlyDropped;
  }
  const queue = Math.max(0, ...ctx.store.metricSeries(app.id, "sdk_queue_size", w.end - 15 * MIN, w.end).map((s) => s.value));
  if (queue >= H.queueNearCap) {
    reasons.push(`its queue reached ${queue} events (default capacity 1000)`);
    evidence.sdk_queue_max = queue;
  }
  const limited = ctx.store.ingestRejections(app.id, ctx.now - 15 * MIN).find((r) => r.status === 429)?.n ?? 0;
  if (limited > 0) {
    reasons.push(`ingest refused ${limited} batches (429)`);
    evidence.refused_429 = limited;
  }
  if (!reasons.length) return [];
  const sampled = [...w.routes15.values()].some((r) => r.weighted_n > r.n);
  return [{
    signal: "data_incomplete",
    subject: "",
    severity: "warning",
    summary: `Data from ${app.name} is incomplete: ${reasons.join(", ")} in the last 15 min${sampled ? "; requests are also being sampled" : ""}.`,
    cause: "The app produces events faster than it can send them, or ingest is limiting it. Health figures for this period undercount.",
    action: "Check the app's network path to Abigaail and its event volume; raise the SDK queue or the ingest rate limit if the volume is real.",
    evidence: { ...evidence, sampling: sampled },
  }];
}

// ---- the agent -------------------------------------------------------------------------

function forApp(ctx: AgentContext, app: App): AgentFinding[] {
  if (app.disabled_at !== null) return [];
  const end = ctx.windowEnd;
  const w: Windows = {
    end,
    routes5: byKey(ctx.store.statsFor(app.id, "route", end - 5 * MIN, end)),
    routes15: byKey(ctx.store.statsFor(app.id, "route", end - 15 * MIN, end)),
  };
  const slots = baselineSlots(ctx.store, app.id, end);
  const routeBase = rowsByKey(ctx.store, app.id, "route", slots);
  const out: AgentFinding[] = [];

  const requests15 = [...w.routes15.values()].reduce((s, r) => s + r.n, 0);
  if (requests15 < H.minRequests15) {
    out.push({
      signal: "too_little_traffic",
      subject: "",
      severity: "unknown",
      summary: `Too little traffic to judge ${app.name}: ${requests15} requests that matter in the last 15 min (at least ${H.minRequests15} needed).`,
      action: "Nothing to do. Error and latency checks still run; status turns green once there is enough traffic.",
      evidence: { requests_15_min: requests15, minimum: H.minRequests15 },
      fact: true,
    });
  }

  out.push(...restarts(ctx, app));

  // Dependencies first, so failing routes they explain fold into them.
  const deps = dependencies(ctx, app, w, slots);
  const causesByWindow = new Map<number, { route: string; host: string; requests: number }[]>();
  const linkedByWindow = new Map<number, { host: string; route: string | null; calls: number; failed: number }[]>();
  for (const failure of routeErrors(app, w, slots, routeBase)) {
    let causes = causesByWindow.get(failure.windowMs);
    if (!causes) causesByWindow.set(failure.windowMs, (causes = ctx.store.failingRequestCauses(app.id, end - failure.windowMs, end)));
    const top = causes
      .filter((c) => c.route === failure.route)
      .sort((a, b) => b.requests - a.requests)[0];
    if (top && top.requests >= H.foldShare * failure.row.status_5xx) {
      // "Stripe is timing out, so /api/checkout fails": one finding, not two.
      let dep = deps.get(top.host);
      if (!dep) {
        // The host's calls fell outside the 5-minute window: use the route finding's window.
        const row = ctx.store.statsFor(app.id, "host", end - failure.windowMs, end).find((r) => r.key === top.host);
        if (!row) {
          out.push(failure.finding);
          continue;
        }
        dep = { host: top.host, severity: "info", row, explains: [] };
        deps.set(top.host, dep);
      }
      dep.severity = worse(dep.severity, failure.finding.severity);
      dep.explains.push({ route: failure.route, failing_requests: top.requests, failures: failure.row.status_5xx, window_ms: failure.windowMs });
      continue;
    }
    let routeCalls = linkedByWindow.get(failure.windowMs);
    if (!routeCalls) linkedByWindow.set(failure.windowMs, (routeCalls = ctx.store.outboundByRoute(app.id, end - failure.windowMs, end)));
    if (!routeCalls.some((l) => l.route === failure.route) && !ctx.store.hasLinkedOutbound(app.id, end - failure.windowMs, end)) {
      // Linking is off for this app (no outbound call carries a parent_id, e.g.
      // Node 22's default), so the link cannot be proven: keep both findings
      // and name the likely cause. With linking on, a route with no linked
      // calls made none, so a failing dependency is not its cause.
      const failing = [...deps.values()].filter((d) => d.failing).sort((a, b) => b.row.failures - a.row.failures)[0];
      if (failing) {
        failure.finding.cause =
          `At the same time ${failing.host} failed ${failing.row.failures} of ${failing.row.n} calls; ` +
          "likely related (calls are not linked on this Node version).";
        failure.finding.evidence.likely_dependency = { host: failing.host, calls: failing.row.n, failed_calls: failing.row.failures, linked: false };
      }
    }
    out.push(failure.finding);
  }

  const linked = ctx.store.outboundByRoute(app.id, end - 5 * MIN, end);
  const slowHosts = new Map<string, Dependency>();
  for (const dep of deps.values()) {
    if (dep.severity === "info") continue;
    if (dep.slow) slowHosts.set(dep.host, dep);
    out.push(dependencyFinding(dep, linked.filter((l) => l.host === dep.host), slots, end));
  }

  for (const { route, finding } of routeLatency(w, slots, routeBase)) {
    // A slow dependency this route calls is the likely cause (AGENTS.md example).
    const called = linked.filter((l) => l.route === route && slowHosts.has(l.host)).map((l) => slowHosts.get(l.host)!);
    if (called.length) {
      const d = called[0]!;
      finding.cause = d.slow!.normal
        ? `At the same time ${d.host} p95 rose from ${ms(d.slow!.normal.median)} to ${ms(d.slow!.p95)}: likely the upstream dependency.`
        : `At the same time ${d.host} p95 is ${ms(d.slow!.p95)}: likely the upstream dependency.`;
      finding.action = `Check ${d.host}'s status page; consider a shorter timeout with a fallback.`;
      finding.evidence.slow_dependencies = called.map((c) => ({ host: c.host, p95: c.slow!.p95, baseline_p95: c.slow!.normal?.median ?? null }));
    }
    out.push(finding);
  }

  out.push(
    ...authFailures(w, slots, routeBase),
    ...saturation(ctx, app, w, slots),
    ...trafficCollapse(ctx, app, w, slots),
    ...errorBursts(ctx, app, w, slots),
    ...dataTrust(ctx, app, w),
  );
  return out;
}

export const health: Agent = {
  name: "health",
  ...SCHEDULE.health,
  forApp,
};
