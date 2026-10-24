// Read models for the dashboard. Pure functions over a StoreReader, scoped by
// app, so the numbers on screen come from the same rollup and baseline rules
// the agents judge with (DECISIONS #42, #49). Where evidence is short they
// return null with a reason; the dashboard shows that grey, never as healthy.

import {
  HOUR_MS, type AgentRun, type AlertChannelRow, type AlertDelivery, type AlertItemRow, type App, type AppStatus, type Finding, type RetentionName,
  type RunOutcome, type StatRow, type StoreReader,
} from "@abigaail/store";
import { baselineSlots, rowsByKey, totals, typicalCount, typicalLevel, typicalP95, typicalRate, type BaselineSource } from "./baseline.js";
import { blockingRoutes, leakVerdicts, unexpectedRestarts, type BlockingRoute, type Crash, type LeakVerdict } from "./resilience.js";
import { median, poissonCdf, poissonUpperTail } from "./stats.js";
import { BASELINE, RESILIENCE, SCHEDULE, STATUS_FRESH_MS, VIEWS as V, windowEnd } from "./thresholds.js";

const MIN = 60_000;

/** Worst first. Grey ranks above green: not knowing is never "fine". */
const STATUS_RANK: Record<AppStatus, number> = { red: 0, amber: 1, grey: 2, green: 3 };
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, unknown: 2, info: 3 };

export const worstStatus = (statuses: readonly AppStatus[]): AppStatus =>
  statuses.reduce<AppStatus>((w, s) => (STATUS_RANK[s] < STATUS_RANK[w] ? s : w), "green");

/** The finding that explains the app's status: most severe, then longest held. Info never counts. */
export function topFinding(findings: readonly Finding[]): Finding | undefined {
  return findings
    .filter((f) => f.severity !== "info")
    .sort((a, b) => SEVERITY_RANK[a.severity]! - SEVERITY_RANK[b.severity]! || b.hits - a.hits || a.first_seen - b.first_seen)[0];
}

// ---- one line per app ---------------------------------------------------------------

export type Liveness =
  | { kind: "running"; since: number }
  | { kind: "silent"; since: number }
  | { kind: "stopped"; since: number }
  | { kind: "never" };

export interface AppSummary {
  app: App;
  status: AppStatus;
  /** One line: the top finding's summary, or "Healthy" / "Too little data". */
  line: string;
  top: Finding | undefined;
  open: Finding[];
  /** Process uptime from the latest boot. Never an availability percentage. */
  liveness: Liveness;
  /** Weighted requests that matter per minute over the last 15 min. */
  rpm: number;
  /** App-wide p95 over the last 15 min; null below VIEWS.minRequests. */
  p95: number | null;
  requests: number;
}

export function appSummary(store: StoreReader, app: App, now: number): AppSummary {
  const { status, findings } = store.appStatus(app.id, { now, freshMs: STATUS_FRESH_MS });
  const top = topFinding(findings);
  const end = windowEnd(now);
  const row = store.statsFor(app.id, "app", end - V.windowMs, end)[0];
  const requests = row?.n ?? 0;
  return {
    app,
    status,
    line: top ? top.summary : status === "green" ? "Healthy" : "Too little data",
    top,
    open: findings,
    liveness: liveness(store, app, findings),
    rpm: (row?.weighted_n ?? 0) / (V.windowMs / MIN),
    p95: row && requests >= V.minRequests ? row.p95 : null,
    requests,
  };
}

function liveness(store: StoreReader, app: App, open: readonly Finding[]): Liveness {
  const boot = store.lastBoot(app.id);
  // The Watchdog decides silence (it knows each app's rhythm); the view only reports it.
  const silent = open.find((f) => f.agent === "watchdog" && f.signal === "silent");
  if (silent) return { kind: "silent", since: app.last_event_at ?? silent.first_seen };
  const stopped = open.find((f) => f.agent === "watchdog" && f.signal === "stopped");
  if (stopped) return { kind: "stopped", since: store.lastLifecycle(app.id)?.ts ?? stopped.first_seen };
  if (!boot) return app.last_event_at === null ? { kind: "never" } : { kind: "running", since: app.created_at };
  return { kind: "running", since: boot.ts };
}

// ---- the map --------------------------------------------------------------------------

export interface RegionInfo {
  lat: number;
  lon: number;
  city: string;
}

export interface Server {
  region: string;
  info: RegionInfo;
  status: AppStatus;
  apps: AppSummary[];
}

/**
 * Apps grouped by region (one pin per region code), worst first, plus the apps
 * that cannot be placed: no region sent, or a code the table does not know.
 */
export function servers(
  summaries: readonly AppSummary[],
  lookup: (region: string) => RegionInfo | undefined,
): { servers: Server[]; unplaced: AppSummary[] } {
  const byRegion = new Map<string, Server>();
  const unplaced: AppSummary[] = [];
  for (const s of summaries) {
    const region = s.app.region;
    const info = region ? lookup(region) : undefined;
    if (!region || !info) {
      unplaced.push(s);
      continue;
    }
    let server = byRegion.get(region);
    if (!server) byRegion.set(region, (server = { region, info, status: "green", apps: [] }));
    server.apps.push(s);
  }
  const list = [...byRegion.values()];
  for (const server of list) server.status = worstStatus(server.apps.map((a) => a.status));
  list.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.region.localeCompare(b.region));
  return { servers: list, unplaced };
}

/** "Is everything OK?" in one sentence (SPEC lesson 11). */
export function headline(summaries: readonly AppSummary[]): { status: AppStatus; text: string } {
  const need = summaries.filter((s) => s.status === "red" || s.status === "amber").length;
  const grey = summaries.filter((s) => s.status === "grey").length;
  if (!summaries.length) return { status: "grey", text: "No apps yet" };
  if (need) return { status: worstStatus(summaries.map((s) => s.status)), text: `${need} ${need === 1 ? "app needs" : "apps need"} you` };
  if (grey) return { status: "grey", text: `Nothing needs you; ${grey} ${grey === 1 ? "app has" : "apps have"} too little data` };
  return { status: "green", text: "Everything is fine" };
}

// ---- the app page ------------------------------------------------------------------------

export type Reason = "too little data" | "no baseline yet";

export interface Measure {
  label: string;
  unit: "/min" | "%" | "ms";
  /** Now (last 15 min). null: too little data to show one. */
  value: number | null;
  /** Usual value for this hour; null with `reason` when there is none. */
  usual: number | null;
  source: BaselineSource;
  reason?: Reason;
}

/** Requests/min, 5xx rate, p95 and event-loop lag, each against its usual value. */
export function fourNumbers(store: StoreReader, appId: string, now: number): Measure[] {
  const end = windowEnd(now);
  const from = end - V.windowMs;
  const row = store.statsFor(appId, "app", from, end)[0];
  const n = row?.n ?? 0;
  const enough = n >= V.minRequests;
  const slots = baselineSlots(store, appId, end);
  const appRows = rowsByKey(store, appId, "app", slots).get("*");
  const lag = store.statsFor(appId, "metric", from, end).find((r) => r.key === "event_loop_lag_p99_ms");
  const lagRows = rowsByKey(store, appId, "metric", slots).get("event_loop_lag_p99_ms");
  const minutes = V.windowMs / MIN;

  // Counts use the route rollup, which every rolled hour has; the app kind
  // only exists for hours rolled since it was added.
  const usualHourly = median(totals(store, appId, "route", slots).map((t) => t.weighted_n));
  const usualRpm = usualHourly === undefined ? null : usualHourly / 60;
  const usualRate = typicalRate(appRows, (r) => r.status_5xx);
  const usualP95 = typicalP95(appRows)?.median;
  const usualLag = typicalLevel(lagRows);

  const measure = (label: string, unit: Measure["unit"], value: number | null, usual: number | null | undefined, enoughNow: boolean): Measure => {
    const m: Measure = { label, unit, value: enoughNow ? value : null, usual: usual ?? null, source: slots.source };
    if (!enoughNow) m.reason = "too little data";
    else if (m.usual === null) m.reason = "no baseline yet";
    return m;
  };
  return [
    measure("Requests", "/min", (row?.weighted_n ?? 0) / minutes, usualRpm, true),
    measure("Server errors", "%", row && n ? (100 * row.status_5xx) / n : null, usualRate === undefined ? null : 100 * usualRate, enough),
    measure("Response time p95", "ms", row?.p95 ?? null, usualP95, enough),
    measure("Event-loop lag p99", "ms", lag?.p50 ?? null, usualLag, (lag?.n ?? 0) >= V.minLagSamples),
  ];
}

export type PointState = "ok" | "few" | "no-data" | "building";

export interface SeriesPoint {
  hour: number;
  p95: number | null;
  state: PointState;
  requests: number;
  /** The normal band for this hour, or null without a baseline. */
  band: { lo: number; mid: number; hi: number } | null;
}

/**
 * Hourly app-wide p95 over the last `hours` closed hours, against each hour's
 * normal band. An hour with no events is a gap ("no-data"), never zero; an
 * hour rolled before the app-wide kind existed is "building".
 */
export function responseSeries(store: StoreReader, appId: string, now: number, hours = 24): SeriesPoint[] {
  const closedEnd = Math.floor(windowEnd(now) / HOUR_MS) * HOUR_MS;
  const from = closedEnd - hours * HOUR_MS;
  const appRows = new Map(store.hourlyRange(appId, "app", from, closedEnd).map((r) => [r.hour, r]));
  const routeHours = new Set(store.hourlyRange(appId, "route", from, closedEnd).map((r) => r.hour));
  const list = Array.from({ length: hours }, (_, k) => from + k * HOUR_MS);
  const rolled = store.rolledHours(appId, list);
  return list.map((hour) => {
    const row = appRows.get(hour);
    let state: PointState = "ok";
    if (!row) state = (rolled.get(hour) ?? 0) === 0 ? "no-data" : routeHours.has(hour) ? "building" : "few";
    else if (row.n < BASELINE.minSlotRequests || row.p95 === null) state = "few";
    return { hour, p95: state === "ok" ? row!.p95 : null, state, requests: row?.n ?? 0, band: band(store, appId, hour) };
  });
}

function band(store: StoreReader, appId: string, hour: number): SeriesPoint["band"] {
  const slots = baselineSlots(store, appId, hour);
  const normal = typicalP95(rowsByKey(store, appId, "app", slots).get("*"));
  if (!normal) return null;
  const spread = Math.max(V.bandMads * 1.4826 * normal.mad, V.bandMinShare * normal.median);
  return { lo: Math.max(0, normal.median - spread), mid: normal.median, hi: normal.median + spread };
}

export interface Dependency {
  host: string;
  /** Calls in the last hour. */
  calls: number;
  /** Failed share (error, timeout or 5xx) in the last hour, %; null below VIEWS.minCalls. */
  failedPct: number | null;
  p95: number | null;
  usualP95: number | null;
}

/** Outbound hosts the app called in the last 24 h, with the last hour's numbers. */
export function dependsOn(store: StoreReader, appId: string, now: number): Dependency[] {
  const end = windowEnd(now);
  const hour = store.statsFor(appId, "host", end - HOUR_MS, end);
  const known = store.hourlyKeys(appId, "host", end - 24 * HOUR_MS, end);
  const base = rowsByKey(store, appId, "host", baselineSlots(store, appId, end));
  const byHost = new Map(hour.map((r) => [r.key, r]));
  const hosts = [...new Set([...known, ...byHost.keys()])];
  return hosts
    .map((host) => {
      const r = byHost.get(host);
      const enough = (r?.n ?? 0) >= V.minCalls;
      return {
        host,
        calls: r?.n ?? 0,
        failedPct: r && enough ? (100 * r.failures) / r.n : null,
        p95: r && enough ? r.p95 : null,
        usualP95: typicalP95(base.get(host))?.median ?? null,
      };
    })
    .sort((a, b) => (b.failedPct ?? -1) - (a.failedPct ?? -1) || b.calls - a.calls || a.host.localeCompare(b.host));
}

export interface RouteChange {
  route: string;
  kind: "new" | "slower" | "faster" | "busier" | "quieter";
  now: number | null;
  usual: number | null;
}

/**
 * Routes whose last closed hour differs from their normal: new since the
 * current release, p95 well above or below normal, or traffic far outside
 * what the baseline predicts (Poisson tails). Empty with a reason without a baseline.
 */
export function routesThatChanged(store: StoreReader, appId: string, now: number): { changes: RouteChange[]; reason?: Reason } {
  const hour = Math.floor(windowEnd(now) / HOUR_MS) * HOUR_MS - HOUR_MS;
  const rows = new Map(store.hourly(appId, "route", [hour]).map((r) => [r.key, r as StatRow]));
  const changes: RouteChange[] = [];

  const release = store.lastBoot(appId)?.release;
  const deploy = release ? store.deploys(appId).find((d) => d.release === release) : undefined;
  const fresh = deploy ? store.firstSeenSince(appId, "route", Math.floor(deploy.first_seen / HOUR_MS) * HOUR_MS) : new Map<string, number>();
  // Routes older than the release are not new, even if the deploy is the app's first.
  const older = deploy ? store.hourlyKeys(appId, "route", 0, Math.floor(deploy.first_seen / HOUR_MS) * HOUR_MS) : new Set<string>();
  const hadHistory = older.size > 0;
  if (hadHistory) for (const route of fresh.keys()) changes.push({ route, kind: "new", now: rows.get(route)?.n ?? null, usual: null });

  const slots = baselineSlots(store, appId, hour);
  if (slots.source === "none") return { changes: changes.slice(0, V.maxRouteChanges), reason: "no baseline yet" };
  const base = rowsByKey(store, appId, "route", slots);
  const score: number[] = changes.map(() => Infinity);

  for (const route of new Set([...rows.keys(), ...base.keys()])) {
    if (fresh.has(route) && hadHistory) continue;
    const row = rows.get(route);
    const n = row?.n ?? 0;
    const p95 = typicalP95(base.get(route));
    if (row?.p95 != null && n >= V.routeMinRequests && p95 && p95.median > 0) {
      const ratio = row.p95 / p95.median;
      if (Math.abs(row.p95 - p95.median) >= V.routeP95MinMs && (ratio >= V.routeP95Ratio || ratio <= 1 / V.routeP95Ratio)) {
        changes.push({ route, kind: ratio > 1 ? "slower" : "faster", now: row.p95, usual: p95.median });
        score.push(Math.abs(Math.log(ratio)));
        continue;
      }
    }
    const expected = typicalCount(base.get(route));
    if (expected >= V.routeTrafficMin && poissonCdf(n, expected) < V.routeTrafficP) {
      changes.push({ route, kind: "quieter", now: n, usual: expected });
      score.push(Math.log((expected + 1) / (n + 1)));
    } else if (n >= V.routeTrafficMin && n >= 2 * expected && poissonUpperTail(n, Math.max(expected, 0.5)) < V.routeTrafficP) {
      changes.push({ route, kind: "busier", now: n, usual: expected });
      score.push(Math.log((n + 1) / (expected + 1)));
    }
  }
  const order = changes.map((c, i) => ({ c, s: score[i]! })).sort((a, b) => b.s - a.s || a.c.route.localeCompare(b.c.route));
  return { changes: order.slice(0, V.maxRouteChanges).map((o) => o.c) };
}

export type EarlierItem =
  | { kind: "finding"; ts: number; finding: Finding }
  | { kind: "deploy"; ts: number; release: string; environment: string };

/** The last 7 days: resolved findings, facts (deploys, restarts) and releases, newest first. */
export function earlier(store: StoreReader, appId: string, now: number): EarlierItem[] {
  const since = now - V.earlierMs;
  const items: EarlierItem[] = [];
  for (const f of store.findingsSince(appId, since)) {
    // Open problems are on the issue card already; open facts (info) belong here.
    if (f.state === "open" && f.severity !== "info") continue;
    // Deploy findings repeat the deploys table.
    if (f.signal === "deploy") continue;
    items.push({ kind: "finding", ts: f.resolved_at ?? f.first_seen, finding: f });
  }
  for (const d of store.deploys(appId)) {
    if (d.first_seen >= since) items.push({ kind: "deploy", ts: d.first_seen, release: d.release, environment: d.environment });
  }
  return items.sort((a, b) => b.ts - a.ts).slice(0, V.maxEarlier);
}

// ---- findings --------------------------------------------------------------------------

/** Worst first: severity, then held longest (most runs), then oldest. */
const worstFirst = (a: Finding, b: Finding) =>
  SEVERITY_RANK[a.severity]! - SEVERITY_RANK[b.severity]! || b.hits - a.hits || a.first_seen - b.first_seen || a.id - b.id;

/**
 * One app's findings: open ones worst first, or those resolved in the last
 * VIEWS.earlierMs, most recently resolved first. Scoped by app: the Findings
 * page calls this once per app and never reads across apps.
 */
export function findingsFor(store: StoreReader, appId: string, opts: { state: "open" | "resolved"; now: number }): Finding[] {
  if (opts.state === "open") return store.openFindings(appId).sort(worstFirst);
  return store
    .findingsSince(appId, opts.now - V.earlierMs, V.maxResolved)
    .filter((f) => f.state === "resolved")
    .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0) || b.id - a.id);
}

/** Open findings about Abigaail itself (app_id NULL), worst first. */
export function systemFindingsView(store: StoreReader): Finding[] {
  return store.systemFindings().sort(worstFirst);
}

// ---- usage on the app page ---------------------------------------------------------------

export interface UsageNumbers {
  /** The closed hours looked at: [from, to). */
  from: number;
  to: number;
  /** Of the 24 hours: how many are rolled up, and how many of those had any events. */
  hoursRolled: number;
  hoursWithData: number;
  /** Requests that matter, weighted; null when no hour had data. */
  requests: number | null;
  topRoutes: { route: string; requests: number }[];
  topReferrers: { domain: string; requests: number }[];
  /** Unique humans yesterday (UTC) against the same weekday over the last 4 weeks. */
  uniques: { day: string; weekday: string; value: number | null; usual: number | null };
  /** Open Usage findings (all info, fact-style). */
  noticed: Finding[];
}

const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Usage over the last 24 closed hours, from the rollup only, as the Usage
 * agent reads it (DECISIONS #52). Hours with no events are "no data", never
 * zero traffic.
 */
export function usageNumbers(store: StoreReader, appId: string, now: number): UsageNumbers {
  const to = Math.floor(windowEnd(now) / HOUR_MS) * HOUR_MS;
  const from = to - 24 * HOUR_MS;
  const hours = Array.from({ length: 24 }, (_, k) => from + k * HOUR_MS);
  const rolled = store.rolledHours(appId, hours);
  const withData = [...rolled.values()].filter((n) => n > 0).length;

  const sum = (rows: readonly StatRow[]) => {
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.key, (by.get(r.key) ?? 0) + r.weighted_n);
    return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const routes = sum(store.hourlyRange(appId, "route", from, to));
  const referrers = sum(store.hourlyRange(appId, "referrer", from, to));

  const DAY = 24 * HOUR_MS;
  const yesterday = Math.floor(windowEnd(now) / DAY) * DAY - DAY;
  const before = [1, 2, 3, 4].map((k) => utcDate(yesterday - k * 7 * DAY));
  const counts = store.dailyUniques(appId, [utcDate(yesterday), ...before]);
  const past = before.map((d) => counts.get(d) ?? 0).filter((n) => n > 0);

  return {
    from,
    to,
    hoursRolled: rolled.size,
    hoursWithData: withData,
    requests: withData ? routes.reduce((t, [, n]) => t + n, 0) : null,
    topRoutes: routes.slice(0, V.usageTop).map(([route, n]) => ({ route, requests: n })),
    topReferrers: referrers.slice(0, V.usageTop).map(([domain, n]) => ({ domain, requests: n })),
    uniques: {
      day: utcDate(yesterday),
      weekday: new Date(yesterday).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
      value: counts.get(utcDate(yesterday)) ?? null,
      usual: past.length >= BASELINE.minWeeks ? (median(past) ?? null) : null,
    },
    noticed: store.openFindings(appId).filter((f) => f.agent === "usage"),
  };
}

// ---- agents --------------------------------------------------------------------------------

export interface AgentView {
  name: string;
  /** From SCHEDULE; undefined for a name that only appears in the run log. */
  schedule: { everyMs: number; timeoutMs?: number } | undefined;
  /**
   * What the Watchdog says about it: red for stalled or failing, amber for
   * slowing, grey when it never ran or the Watchdog itself is not running,
   * else green. The page never judges agents on its own.
   */
  status: AppStatus;
  /** The Watchdog finding behind a non-green status, if any. */
  finding: Finding | undefined;
  /** Not running by configuration (alerts with no channel configured): shown grey with this reason. */
  off?: string;
  lastOkAt: number | undefined;
  /** Newest first, at most VIEWS.agentRuns. */
  runs: AgentRun[];
  medianMs: number | null;
  maxMs: number | null;
  /** Runs in the last 24 h per outcome. */
  day: Record<RunOutcome, number>;
  /** Open findings this agent holds, across apps (counted per app) and about Abigaail. */
  open: number;
}

/** One row per scheduled agent (and the rollup), plus any other name in the run log. */
export function agentsView(store: StoreReader, apps: readonly App[], now: number): AgentView[] {
  const system = store.systemFindings();
  const watchdogFresh = (() => {
    const t = store.lastOkRun("watchdog");
    return t !== undefined && now - t <= STATUS_FRESH_MS;
  })();
  // Per app, so no query reads across apps.
  const openByAgent = new Map<string, number>();
  for (const f of [...apps.flatMap((a) => store.openFindings(a.id)), ...system]) openByAgent.set(f.agent, (openByAgent.get(f.agent) ?? 0) + 1);

  const names = [...new Set([...Object.keys(SCHEDULE), ...store.agentNames()])];
  return names.map((name) => {
    const runs = store.recentRuns(name, V.agentRuns);
    const ok = runs.filter((r) => r.outcome === "ok").map((r) => r.duration_ms);
    const about = (signal: string) => system.find((f) => f.agent === "watchdog" && f.fingerprint === `watchdog:${signal}:${name}`);
    const finding = about("agent_stalled") ?? about("agent_failing") ?? about("agent_slowing");
    // The alerter runs only with a channel configured; the server records the channels (none: off).
    const off = name === "alerts" && !store.alertChannels().length ? "off (no channel configured)" : undefined;
    const status: AppStatus = off
      ? "grey"
      : finding
        ? finding.severity === "critical" ? "red" : "amber"
        : !runs.length || !watchdogFresh ? "grey" : "green";
    return {
      name,
      schedule: (SCHEDULE as Record<string, { everyMs: number; timeoutMs?: number }>)[name],
      status,
      ...(off ? { off } : {}),
      finding,
      lastOkAt: store.lastOkRun(name),
      runs,
      medianMs: median(ok) ?? null,
      maxMs: ok.length ? Math.max(...ok) : null,
      day: store.runOutcomes(name, now - 24 * HOUR_MS),
      open: openByAgent.get(name) ?? 0,
    };
  });
}

// ---- retention -----------------------------------------------------------------------------

/** What each retention policy covers, in the order the dashboard lists them. */
export const RETENTION_LABEL: Record<RetentionName, string> = {
  events: "Raw events: requests, calls, errors, metrics, with the daily visitor ID",
  rollups: "Hourly summaries (counts and percentiles; the baselines)",
  daily_uniques: "Unique humans per day (counts only)",
  findings: "Resolved findings",
  agent_runs: "Agent runs",
  ingest_rejections: "Refused ingest requests (counts per minute)",
  db_size_samples: "Database size samples",
  audit_log: "Admin and sign-in audit logs",
  alerts: "Alert messages sent and their delivery",
  profiles: "Profiles (functions, files and lines; no data)",
  sessions: "Dashboard sessions",
};

export interface RetentionRow {
  name: RetentionName;
  label: string;
  /** 0: deleted when it expires (sessions). */
  keepDays: number;
  lastRunAt: number | null;
  lastDeleted: number | null;
}

/**
 * The periods the server enforces, as it recorded them (the dashboard never
 * reads the server's environment). Empty when the server has not recorded any yet.
 */
export function retentionView(store: StoreReader): RetentionRow[] {
  const order = Object.keys(RETENTION_LABEL) as RetentionName[];
  return store
    .retentionPolicy()
    .filter((p) => order.includes(p.name))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
    .map((p) => ({ name: p.name, label: RETENTION_LABEL[p.name], keepDays: p.keep_days, lastRunAt: p.last_run_at, lastDeleted: p.last_deleted }));
}

/** For one app's page: how long its raw events and summaries are kept, and its oldest stored event. */
export function appRetention(store: StoreReader, appId: string): { eventsDays: number | null; rollupsDays: number | null; oldestEvent: number | null } {
  const policy = new Map(store.retentionPolicy().map((p) => [p.name, p.keep_days]));
  return { eventsDays: policy.get("events") ?? null, rollupsDays: policy.get("rollups") ?? null, oldestEvent: store.oldestEventTs(appId) ?? null };
}

// ---- alerts (DECISIONS #99) -----------------------------------------------------------

export interface DeliveryView extends AlertDelivery {
  /** The findings it carried, app by app (read with app_id = ?, never across apps). */
  items: { app: string; fingerprint: string; change: "firing" | "recovered"; finding_id: number | null }[];
}

export interface AlertsView {
  channels: AlertChannelRow[];
  deliveries: DeliveryView[];
}

/** Configured channels and the latest messages with what each carried. */
export function alertsView(store: StoreReader, apps: readonly App[], limit = 50): AlertsView {
  const deliveries = store.recentDeliveries(limit);
  const since = deliveries.length ? Math.min(...deliveries.map((d) => d.created_at)) : Infinity;
  const byDelivery = new Map<number, DeliveryView["items"]>();
  if (deliveries.length) {
    const scopes: { id: string | null; name: string }[] = [...apps.map((a) => ({ id: a.id, name: a.name })), { id: null, name: "Abigaail" }];
    for (const scope of scopes) {
      for (const i of store.alertItems(scope.id, since)) {
        const list = byDelivery.get(i.delivery) ?? [];
        list.push({ app: scope.name, fingerprint: i.fingerprint, change: i.change, finding_id: i.finding_id });
        byDelivery.set(i.delivery, list);
      }
    }
  }
  return { channels: store.alertChannels(), deliveries: deliveries.map((d) => ({ ...d, items: byDelivery.get(d.id) ?? [] })) };
}

/** Per finding of one app (null: Abigaail itself): the messages about it in the last `sinceMs`, newest first. */
export function alertsByFinding(store: StoreReader, appId: string | null, now: number, sinceMs = 7 * 24 * 60 * MIN): Map<number, AlertItemRow[]> {
  const out = new Map<number, AlertItemRow[]>();
  for (const i of store.alertItems(appId, now - sinceMs)) {
    if (i.finding_id === null) continue;
    const list = out.get(i.finding_id) ?? [];
    list.push(i);
    out.set(i.finding_id, list);
  }
  return out;
}

// ---- runtime (the Resilience agent's numbers) ----------------------------------------------

export interface MemoryPoint {
  /** Start of the bucket. */
  t: number;
  /** Lowest reading in the bucket, MB; null without one. */
  heapFloor: number | null;
  rss: number | null;
  external: number | null;
}

export interface RuntimeView {
  /** Whether the app's SDK sends runtime signals (a heap floor, a ready event). */
  signals: boolean;
  /**
   * Memory per RUNTIME_BUCKET_MS over the last day, starting at the first
   * bucket with a reading (a short history is not squeezed into the right edge).
   */
  memory: MemoryPoint[];
  /** Starts in the same day, for markers. */
  boots: number[];
  heapLimitMb: number | null;
  memoryLimitMb: number | null;
  leaks: LeakVerdict[];
  /** Routes blocking the loop now (the agent's rule) and blocks per route over the last day. */
  blockingNow: BlockingRoute[];
  blocks24h: { route: string | null; blocks: number; blocked_ms: number; max_ms: number }[];
  /** Unexpected restarts over the last day, newest first, with their cause. */
  crashes: Crash[];
  /** Startup times over the last day, newest first, and the usual one. */
  startups: { ts: number; release: string; startup_ms: number }[];
  usualStartupMs: number | null;
  /** Open Resilience findings, worst first. */
  findings: Finding[];
  /** The profiler's own start pauses over the last day (profiler_pause_ms), or null without any. */
  profilerPauses: { count: number; maxMs: number; totalMs: number } | null;
}

const RUNTIME_BUCKET_MS = 15 * MIN;
const DAY_MS = 24 * HOUR_MS;

/** The Runtime tab: the same rules the Resilience agent judges with (insights/resilience.ts). */
export function runtimeView(store: StoreReader, appId: string, now: number): RuntimeView {
  const end = windowEnd(now);
  const from = Math.floor((now - DAY_MS) / RUNTIME_BUCKET_MS) * RUNTIME_BUCKET_MS;
  const buckets = new Map<number, MemoryPoint>();
  for (let t = from; t < now; t += RUNTIME_BUCKET_MS) buckets.set(t, { t, heapFloor: null, rss: null, external: null });
  const fill = (name: string, key: "heapFloor" | "rss" | "external") => {
    for (const p of store.metricSeries(appId, name, from, now + 1)) {
      const b = buckets.get(Math.floor(p.ts / RUNTIME_BUCKET_MS) * RUNTIME_BUCKET_MS);
      if (b && (b[key] === null || p.value < b[key]!)) b[key] = p.value;
    }
  };
  fill("heap_floor_mb", "heapFloor");
  fill("memory_rss_mb", "rss");
  fill("memory_external_mb", "external");
  const all = [...buckets.values()];
  const first = all.findIndex((p) => p.heapFloor !== null || p.rss !== null || p.external !== null);
  const memory = first < 0 ? all : all.slice(first);
  const life = store.lifecycleDetail(appId, from, now + 1);
  const ready = life.filter((r) => r.kind === "ready");
  const latestReady = ready.at(-1);
  const perRoute = new Map<string | null, { blocks: number; blocked_ms: number; max_ms: number }>();
  for (const b of store.blocks(appId, from, now + 1)) {
    const a = perRoute.get(b.route) ?? { blocks: 0, blocked_ms: 0, max_ms: 0 };
    a.blocks += b.count;
    a.blocked_ms += b.total_ms;
    a.max_ms = Math.max(a.max_ms, b.max_ms);
    perRoute.set(b.route, a);
  }
  const startups = store.startups(appId, from, now + 1, RESILIENCE.startupHistory);
  const pauses = store.metricSeries(appId, "profiler_pause_ms", now - DAY_MS, now + 1).map((p) => p.value);
  const before = store.startups(appId, now - 30 * DAY_MS, now + 1, RESILIENCE.startupHistory).map((s) => s.startup_ms);
  return {
    signals: memory.some((p) => p.heapFloor !== null) || ready.length > 0,
    memory,
    boots: life.filter((r) => r.kind === "boot" && r.ts >= memory[0]!.t).map((r) => r.ts),
    heapLimitMb: latestReady?.heap_limit_mb ?? null,
    memoryLimitMb: latestReady?.memory_limit_mb ?? null,
    leaks: leakVerdicts(store, appId, end),
    blockingNow: blockingRoutes(store, appId, end),
    blocks24h: [...perRoute]
      .map(([route, a]) => ({ route, ...a, blocked_ms: Math.round(a.blocked_ms) }))
      .sort((a, b) => b.blocked_ms - a.blocked_ms)
      .slice(0, 10),
    crashes: unexpectedRestarts(store, appId, now, DAY_MS).reverse(),
    startups,
    usualStartupMs: before.length >= RESILIENCE.startupMinHistory ? median(before)! : null,
    findings: store.openFindings(appId).filter((f) => f.agent === "resilience").sort(worstFirst),
    profilerPauses: pauses.length ? { count: pauses.length, maxMs: Math.max(...pauses), totalMs: pauses.reduce((a, b) => a + b, 0) } : null,
  };
}
