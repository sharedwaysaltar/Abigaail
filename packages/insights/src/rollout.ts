// The Rollout Safety rules (docs/AGENTS.md agent 5, DECISIONS #131-#133),
// shared by the Rollout Safety agent, Health and Resilience (which fold their
// route and restart findings into its release finding) and the dashboard's
// Releases view, so all of them give the same answer.
//
// A release is judged against the app's own normal: the same routes at the
// same hours of the week before the deploy (BASELINE), counting only traffic
// that matters. `judge` is pure arithmetic over gathered numbers, so its
// statistics can be tested over thousands of simulated days; `releaseInput`
// gathers those numbers from the store, every query scoped by app.

import { HOUR_MS, type Deploy, type Finding, type HourlyStat, type StoreReader } from "@abigaail/store";
import { baselineSlots, typicalP95, type BaselineSource } from "./baseline.js";
import { unexpectedRestarts, restartVerdict, type Crash } from "./resilience.js";
import { binomialUpperTail, median, poissonCdf, wilsonLower } from "./stats.js";
import { RESILIENCE, ROLLOUT as R } from "./thresholds.js";

const MIN = 60_000;

export type Verdict = "too_little" | "fine" | "watch" | "rollback";
export const VERDICT_RANK: Record<Verdict, number> = { too_little: 0, fine: 1, watch: 2, rollback: 3 };

/** What one route did since the deploy, and what it usually does. */
export interface RouteInput {
  route: string;
  /** Requests that matter on the new release since the deploy. */
  after: { n: number; weighted: number; x5: number; x4: number; x404: number };
  /** The same route before the deploy (pooled baseline hours); undefined if it had no traffic then. */
  before?: { n: number; weighted: number; x5: number; x4: number };
  /** Requests that matter expected over the same span (baseline, weighted); undefined without a baseline. */
  expected?: number;
  /** Share of the app's usual traffic this route carries. */
  usualShare?: number;
  /** Latency over the latest window: requests, how many above the usual p95, their p95, the usual p95. */
  latency?: { n: number; above: number; p95: number | null; usual: number };
  /** Recent failures that come from a failing outbound host (Health's dependency finding, #51). */
  dependency?: { host: string; requests: number };
}

export interface LoopInput {
  crashes: number;
  /** The cause most of them share, in words (Resilience's causeText). */
  text: string;
  firstAt: number;
}

export interface JudgeInput {
  /** Time since the deploy. */
  spanMs: number;
  /** All requests that matter since the deploy, and the app's pooled usual 5xx / 4xx counts. */
  appAfter: number;
  appBefore?: { n: number; x5: number; x4: number };
  routes: RouteInput[];
  /** The whole app's latest window against its usual p95. */
  appLatency?: { n: number; above: number; p95: number | null; usual: number };
  /** Error types (class + route) never seen in the week before the deploy. */
  newErrors: { key: string; n: number }[];
  /** A crash loop on the new release that began right after the deploy. */
  loop?: LoopInput;
  /** The previous release was already failing in the half hour before the deploy (the change did not start with it). */
  preDeployAnomaly?: string;
  /** Health reports a traffic collapse while heartbeats arrive (proxy, DNS): quiet routes are not the release's. */
  collapse: boolean;
  /** How many looks the release gets (every minute for judgeMs). */
  looks: number;
}

export type SignalKind = "errors" | "client_errors" | "latency" | "quiet" | "app_latency" | "new_error" | "loop";

export interface Signal {
  kind: SignalKind;
  route?: string;
  /** Exact one-sided p-value of the test (undefined for new error types and loops, judged by rule). */
  p?: number;
  /** p × tests × looks (the union bound), at most 1. */
  corrected?: number;
  /** Passed the significance test and the effect-size gates. */
  significant: boolean;
  /** Meets one of the rollback impact rules on its own (impact, before confidence). */
  impact: boolean;
  /** Extra failures (or slow requests) above what the usual share explains. */
  excess: number;
  /** Plain numbers for summaries and the dashboard. */
  detail: Record<string, number | string | null>;
}

export interface Judgement {
  raw: Verdict;
  signals: Signal[];
  tests: number;
  /** How impact and confidence were measured, and which gate stopped a rollback. */
  impact: { met: boolean; rule: string | null; excess: number; excessShare: number };
  confidence: { met: boolean; corrected: number | null; why: string | null };
  /** What Health and Resilience may fold into this finding (only for watch and rollback). */
  covers: Covers;
}

export interface Covers {
  /** route -> the signals this finding reports for it ("errors" covers Health's server_errors, "latency" its latency). */
  routes: Record<string, SignalKind[]>;
  /** Error keys ("Type /route") covered for Health's new_error and error_burst. */
  error_keys: string[];
  /** A crash loop after the deploy: covers Resilience's restart. */
  loop: boolean;
}

const correct = (p: number, tests: number, looks: number) => Math.min(1, p * Math.max(1, tests) * Math.max(1, looks));

/** The usual failure share: the route's own when it had enough traffic, else the app's; never 0 (Laplace). */
function usualShare(x: number, n: number, app?: { x: number; n: number }): number {
  if (n >= R.minBaselineRequests || !app) return (x + 1) / (n + 2);
  return (app.x + 1) / (app.n + 2);
}

/**
 * The verdict for one look at a release (pure). Each test is exact and
 * one-sided, corrected for every test in this look and every look the release
 * gets; a signal also has to pass its effect-size gate, so a tiny but
 * "significant" change on a busy route is no finding.
 */
export function judge(input: JudgeInput): Judgement {
  const signals: Signal[] = [];
  let tests = 0;
  const routeTests: { route: RouteInput; kind: SignalKind; p: number; gate: boolean; excess: number; impact: boolean; detail: Signal["detail"] }[] = [];
  const appErrors = input.appBefore ? { x: input.appBefore.x5, n: input.appBefore.n } : undefined;
  const appClient = input.appBefore ? { x: input.appBefore.x4, n: input.appBefore.n } : undefined;
  const observed = input.spanMs >= R.minObservedMs;

  if (observed) {
    for (const r of input.routes) {
      if (r.dependency) continue; // A failing dependency is Health's finding, not the release's.
      if (r.after.n >= R.minRequests && (r.before || appErrors)) {
        for (const [kind, x1, x0, app] of [
          ["errors", r.after.x5, r.before?.x5 ?? 0, appErrors],
          ["client_errors", r.after.x4, r.before?.x4 ?? 0, appClient],
        ] as const) {
          tests++;
          const p0 = usualShare(x0, r.before?.n ?? 0, app);
          const lb = wilsonLower(x1, r.after.n);
          const gate = x1 >= R.minFailures && lb >= Math.max(R.errorFactor * p0, p0 + R.errorFloor);
          // Only computed when it can matter: under no change the gate almost never opens.
          const p = gate ? binomialUpperTail(x1, r.after.n, p0) : 1;
          const excess = Math.max(0, x1 - p0 * r.after.n);
          const impact = (r.usualShare ?? 0) >= R.routeTrafficShare && lb >= R.routeFailShare;
          routeTests.push({ route: r, kind, p, gate, excess, impact, detail: { requests: r.after.n, failures: x1, share: x1 / r.after.n, usual_share: p0, wilson_lower: lb, not_found: kind === "client_errors" ? r.after.x404 : null } });
        }
      }
      if (r.latency && r.latency.n >= R.minLatencyRequests && r.latency.p95 !== null) {
        tests++;
        const l = r.latency;
        const gate = l.p95! >= R.latencyRatio * l.usual && l.p95! - l.usual >= R.latencyFloorMs;
        const p = gate ? binomialUpperTail(l.above, l.n, R.aboveUsualShare) : 1;
        const excess = Math.max(0, l.above - R.aboveUsualShare * l.n);
        const impact = (r.usualShare ?? 0) >= R.routeTrafficShare && l.p95! >= R.latencyRollbackRatio * l.usual;
        routeTests.push({ route: r, kind: "latency", p, gate, excess, impact, detail: { requests: l.n, above_usual: l.above, p95: l.p95, usual_p95: l.usual } });
      }
      if (r.expected !== undefined && r.expected >= R.quietMinExpected) {
        tests++;
        const gate = r.after.weighted <= R.quietShare * r.expected && !input.collapse;
        const p = gate ? poissonCdf(Math.floor(r.after.weighted), r.expected) : 1;
        const impact = (r.usualShare ?? 0) >= R.routeTrafficShare;
        routeTests.push({ route: r, kind: "quiet", p, gate, excess: Math.max(0, r.expected - r.after.weighted), impact, detail: { requests: Math.round(r.after.weighted), expected: Math.round(r.expected) } });
      }
    }
  }
  let appSlow: Omit<Signal, "corrected" | "significant"> | undefined;
  if (observed && input.appLatency && input.appLatency.n >= R.minLatencyRequests && input.appLatency.p95 !== null) {
    tests++;
    const l = input.appLatency;
    const gate = l.p95! >= R.latencyRatio * l.usual && l.p95! - l.usual >= R.latencyFloorMs;
    const p = gate ? binomialUpperTail(l.above, l.n, R.aboveUsualShare) : 1;
    appSlow = {
      kind: "app_latency",
      p,
      impact: wilsonLower(l.above, l.n) >= R.appSlowShare,
      excess: Math.max(0, l.above - R.aboveUsualShare * l.n),
      detail: { requests: l.n, above_usual: l.above, p95: l.p95, usual_p95: l.usual, gate: gate ? 1 : 0 },
    };
  }

  const alphaWatch = (p: number) => correct(p, tests, input.looks) < R.alphaWatch;
  for (const t of routeTests) {
    const significant = t.gate && alphaWatch(t.p);
    signals.push({ kind: t.kind, route: t.route.route, p: t.p, corrected: correct(t.p, tests, input.looks), significant, impact: significant && t.impact, excess: t.excess, detail: t.detail });
  }
  if (appSlow) {
    const significant = appSlow.detail.gate === 1 && alphaWatch(appSlow.p!);
    signals.push({ ...appSlow, corrected: correct(appSlow.p!, tests, input.looks), significant, impact: significant && appSlow.impact });
  }
  if (observed) {
    for (const e of input.newErrors) {
      if (e.n < R.newErrorMin) continue;
      signals.push({ kind: "new_error", route: e.key.slice(e.key.indexOf(" ") + 1), significant: true, impact: false, excess: e.n, detail: { error: e.key, count: e.n } });
    }
  }
  if (input.loop) {
    signals.push({ kind: "loop", significant: true, impact: true, excess: input.loop.crashes, detail: { crashes: input.loop.crashes, cause: input.loop.text } });
  }

  const significant = signals.filter((s) => s.significant);
  // Extra failures over every route and kind that is significant, against all requests since the deploy.
  const failures = significant.filter((s) => s.kind === "errors" || s.kind === "client_errors");
  const excess = failures.reduce((sum, s) => sum + s.excess, 0);
  const excessShare = input.appAfter > 0 ? excess / input.appAfter : 0;

  let rule: string | null = null;
  let evidence = 0;
  let corrected: number | null = null;
  const take = (r: string, s: Signal[], ev: number) => {
    if (rule) return;
    rule = r;
    evidence = ev;
    corrected = Math.max(...s.map((x) => x.corrected ?? 0));
  };
  const loop = significant.find((s) => s.kind === "loop");
  if (loop) take("crash_loop", [loop], loop.excess);
  const broken = failures.filter((s) => s.impact).sort((a, b) => b.excess - a.excess);
  if (broken.length) take("route_failing", [broken[0]!], broken[0]!.excess);
  if (failures.length && excessShare >= R.excessShare) take("excess_failures", failures, excess);
  const slowRoute = significant.filter((s) => s.kind === "latency" && s.impact).sort((a, b) => b.excess - a.excess)[0];
  if (slowRoute) take("route_slow", [slowRoute], slowRoute.excess);
  const slowApp = significant.find((s) => s.kind === "app_latency" && s.impact);
  if (slowApp) take("app_slow", [slowApp], slowApp.excess);
  const quiet = significant.filter((s) => s.kind === "quiet" && s.impact).sort((a, b) => b.excess - a.excess)[0];
  if (quiet) take("route_quiet", [quiet], quiet.excess);

  // Confidence: corrected for every test and look, enough extra failures, a change that began with the deploy.
  let why: string | null = null;
  if (rule && rule !== "crash_loop") {
    if (corrected! >= R.alphaRollback) why = "not yet significant enough for a rollback";
    else if (evidence < R.minExcess) why = `only ${Math.round(evidence)} extra ${rule === "route_slow" || rule === "app_slow" ? "slow requests" : rule === "route_quiet" ? "missing requests" : "failures"} so far (at least ${R.minExcess} needed)`;
    else if (input.preDeployAnomaly) why = `the previous release was already failing before the deploy (${input.preDeployAnomaly})`;
  }
  const impactMet = rule !== null;
  const confident = impactMet && why === null;

  let raw: Verdict;
  if (impactMet && confident) raw = "rollback";
  else if (significant.length) raw = "watch";
  else if (observed && input.spanMs >= R.fineMinMs && input.appAfter >= R.fineMinRequests && signals.length + tests > 0) raw = "fine";
  else raw = "too_little";

  const covers: Covers = { routes: {}, error_keys: [], loop: false };
  if (raw === "watch" || raw === "rollback") {
    for (const s of significant) {
      if (s.kind === "new_error") covers.error_keys.push(String(s.detail.error));
      else if (s.kind === "loop") covers.loop = true;
      else if (s.route) (covers.routes[s.route] ??= []).push(s.kind);
    }
  }
  return {
    raw,
    signals,
    tests,
    impact: { met: impactMet, rule, excess, excessShare },
    confidence: { met: confident, corrected, why },
    covers,
  };
}

/**
 * The verdict to report this run: a verdict, or a change of verdict, must hold
 * on 2 runs in a row (#132). `previous` is this release's finding from the
 * last run (its raw and reported verdicts), if it ran just before.
 */
export function heldVerdict(raw: Verdict, previous: { raw: Verdict; reported: Verdict } | undefined): Verdict {
  if (!previous) return "too_little";
  return previous.raw === raw ? raw : previous.reported;
}

// ---- gathering ------------------------------------------------------------------

/** The release judged now: the latest deploy within judgeMs, on a release the app actually named. */
export function judgedRelease(store: StoreReader, appId: string, end: number): (Deploy & { deployed_at: number; replaced_release: string }) | undefined {
  const deploys = store.deploys(appId).filter((d) => d.deployed_at !== null && d.replaced_release !== null);
  const latest = deploys.sort((a, b) => b.deployed_at! - a.deployed_at!)[0];
  if (!latest || latest.release === "unknown") return undefined;
  if (end - latest.deployed_at! > R.judgeMs || latest.deployed_at! > end) return undefined;
  return latest as Deploy & { deployed_at: number; replaced_release: string };
}

export interface BeforeAfter {
  route: string;
  after: RouteInput["after"];
  before?: RouteInput["before"];
  expected?: number;
  usualShare?: number;
  latency?: RouteInput["latency"];
  dependency?: RouteInput["dependency"];
}

export interface ReleaseData {
  release: string;
  previous: string;
  deployedAt: number;
  end: number;
  deploy: Deploy;
  /** Where "before" came from: the same hours of the week, the same hours on recent days, the previous release's last hours, or nothing. */
  baseline: BaselineSource | "previous_release";
  /** For "previous_release": how long before the deploy it covers. */
  baselineMs?: number;
  input: JudgeInput;
  routes: BeforeAfter[];
  /** Restarts on the new release since the deploy (for the view). */
  crashes: Crash[];
}

const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

/** Pool a set of rollup rows per route key. */
function pool(rows: readonly HourlyStat[]): Map<string, { n: number; weighted: number; x5: number; x4: number }> {
  const out = new Map<string, { n: number; weighted: number; x5: number; x4: number }>();
  for (const r of rows) {
    const p = out.get(r.key) ?? { n: 0, weighted: 0, x5: 0, x4: 0 };
    p.n += r.n;
    p.weighted += r.weighted_n;
    p.x5 += r.status_5xx;
    p.x4 += r.status_4xx - r.status_401_403;
    out.set(r.key, p);
  }
  return out;
}

/**
 * Everything `judge` needs for the release judged at `end`, from the store.
 * "After": the new release's own rows since the deploy (a rolling deploy's
 * old processes never count). "Before": the same hours of the week over the
 * last 4 weeks, or the same hours on recent days (#49), from hours wholly
 * before the deploy; without either, the previous release's last hours.
 */
export function releaseInput(store: StoreReader, appId: string, end: number, deploy?: Deploy & { deployed_at: number; replaced_release: string }): ReleaseData | undefined {
  const d = deploy ?? judgedRelease(store, appId, end);
  if (!d) return undefined;
  const release = d.release;
  const previous = d.replaced_release;
  const deployedAt = d.deployed_at;
  const spanEnd = Math.min(end, deployedAt + R.judgeMs);
  const spanMs = Math.max(0, spanEnd - deployedAt);
  const deployHour = Math.floor(deployedAt / HOUR_MS) * HOUR_MS;

  const afterRows = store.releaseRouteCounts(appId, release, deployedAt, spanEnd);

  // Baseline: per hour the span covers, its slots, keeping only hours wholly before the deploy.
  const perHour: { fraction: number; hours: number[] }[] = [];
  let source: BaselineSource = "none";
  for (let h = deployHour; h < spanEnd; h += HOUR_MS) {
    const fraction = (Math.min(spanEnd, h + HOUR_MS) - Math.max(deployedAt, h)) / HOUR_MS;
    const slots = baselineSlots(store, appId, h);
    const hours = slots.hours.filter((x) => x < deployHour);
    if (hours.length && source === "none") source = slots.source;
    perHour.push({ fraction, hours });
  }
  const union = [...new Set(perHour.flatMap((p) => p.hours))].sort((a, b) => a - b);
  const rows = union.length ? store.hourly(appId, "route", union) : [];

  let before = pool(rows);
  let expectedOf: (route: string) => number | undefined;
  let usualP95: (route: string) => number | undefined;
  let appUsual: number | undefined;
  let baseline: ReleaseData["baseline"] = source;
  let baselineMs: number | undefined;
  if (rows.length) {
    const byHour = new Map<number, Map<string, HourlyStat>>();
    for (const r of rows) {
      let m = byHour.get(r.hour);
      if (!m) byHour.set(r.hour, (m = new Map()));
      m.set(r.key, r);
    }
    expectedOf = (route) => sum(perHour, (p) => p.fraction * (median(p.hours.map((h) => byHour.get(h)?.get(route)?.weighted_n ?? 0)) ?? 0));
    // Latency: the usual p95 for the hour the latest window ends in.
    const lastHours = perHour.at(-1)?.hours ?? [];
    usualP95 = (route) => typicalP95(lastHours.map((h) => byHour.get(h)?.get(route)))?.median;
    const appRows = lastHours.length ? store.hourly(appId, "app", lastHours) : [];
    appUsual = typicalP95(lastHours.map((h) => appRows.find((r) => r.hour === h)))?.median;
  } else {
    // No hour-of-week or daily history: the previous release's own last hours before the deploy.
    const prev = store.deploys(appId).find((x) => x.release === previous);
    const prevStart = prev ? (prev.deployed_at ?? prev.first_seen) : deployedAt - R.fallbackMs;
    const from = Math.max(deployedAt - R.fallbackMs, prevStart);
    const fallbackMs = deployedAt - from;
    const counts = fallbackMs > 0 ? store.releaseRouteCounts(appId, previous, from, deployedAt) : [];
    if (counts.length) {
      baseline = "previous_release";
      baselineMs = fallbackMs;
      before = new Map(counts.map((c) => [c.route, { n: c.n, weighted: c.weighted_n, x5: c.status_5xx, x4: c.status_4xx_other }]));
      expectedOf = (route) => ((before.get(route)?.weighted ?? 0) * spanMs) / fallbackMs;
      const p95s = new Map(store.statsFor(appId, "route", from, deployedAt, previous).filter((r) => r.n >= 20).map((r) => [r.key, r.p95!]));
      usualP95 = (route) => p95s.get(route);
      const app = store.statsFor(appId, "app", from, deployedAt, previous)[0];
      appUsual = app && app.n >= 20 ? app.p95! : undefined;
    } else {
      expectedOf = () => undefined;
      usualP95 = () => undefined;
    }
  }
  const usualTotal = sum([...before.values()], (b) => b.weighted);

  // Latency over the latest window, past the cold start.
  const latFrom = Math.max(deployedAt + R.warmupMs, spanEnd - R.latencyWindowMs);
  const thresholds = new Map<string, number>();
  for (const r of afterRows) {
    const u = usualP95(r.route);
    if (u !== undefined) thresholds.set(r.route, u);
  }
  const latency = latFrom < spanEnd && (thresholds.size || appUsual !== undefined)
    ? store.releaseExceedances(appId, release, latFrom, spanEnd, thresholds, appUsual)
    : [];

  // Recent failures that a failing dependency explains (Health folds them into that host, #51).
  const depFrom = Math.max(deployedAt, spanEnd - R.dependencyWindowMs);
  const recent = new Map(store.releaseRouteCounts(appId, release, depFrom, spanEnd).map((c) => [c.route, c.status_5xx]));
  const dependency = new Map<string, { host: string; requests: number }>();
  for (const c of store.failingRequestCauses(appId, depFrom, spanEnd)) {
    const failing = recent.get(c.route) ?? 0;
    if (failing > 0 && c.requests >= R.dependencyShare * failing && c.requests > (dependency.get(c.route)?.requests ?? 0)) dependency.set(c.route, { host: c.host, requests: c.requests });
  }

  const routes: BeforeAfter[] = [];
  const seen = new Set<string>();
  for (const a of afterRows) {
    seen.add(a.route);
    const b = before.get(a.route);
    const lat = latency.find((l) => l.route === a.route);
    const expected = expectedOf(a.route);
    routes.push({
      route: a.route,
      after: { n: a.n, weighted: a.weighted_n, x5: a.status_5xx, x4: a.status_4xx_other, x404: a.status_404 },
      ...(b ? { before: b } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(usualTotal > 0 ? { usualShare: (b?.weighted ?? 0) / usualTotal } : {}),
      ...(lat && thresholds.has(a.route) ? { latency: { n: lat.n, above: lat.above, p95: lat.p95, usual: thresholds.get(a.route)! } } : {}),
      ...(dependency.has(a.route) ? { dependency: dependency.get(a.route)! } : {}),
    });
  }
  // Routes the new release never answered (went quiet): usual traffic, no rows since the deploy.
  for (const [route, b] of before) {
    if (seen.has(route) || route === "unmatched" || route === "other") continue;
    const expected = expectedOf(route);
    if (expected === undefined) continue;
    routes.push({ route, after: { n: 0, weighted: 0, x5: 0, x4: 0, x404: 0 }, before: b, expected, usualShare: usualTotal > 0 ? b.weighted / usualTotal : 0 });
  }
  routes.sort((x, y) => (y.usualShare ?? 0) - (x.usualShare ?? 0) || y.after.n - x.after.n || (x.route < y.route ? -1 : 1));

  const appAfter = sum(afterRows, (r) => r.n);
  const pooled = [...before.values()];
  const appBefore = pooled.length ? { n: sum(pooled, (p) => p.n), x5: sum(pooled, (p) => p.x5), x4: sum(pooled, (p) => p.x4) } : undefined;
  const appLat = latency.find((l) => l.route === "*");

  // The previous release in the half hour before the deploy: already failing means the deploy did not start it.
  let preDeployAnomaly: string | undefined;
  if (baseline !== "previous_release" && rows.length) {
    for (const c of store.releaseRouteCounts(appId, previous, deployedAt - R.preDeployMs, deployedAt)) {
      const b = before.get(c.route);
      if (c.n < R.minRequests) continue;
      for (const [x1, x0, what] of [[c.status_5xx, b?.x5 ?? 0, "5xx"], [c.status_4xx_other, b?.x4 ?? 0, "4xx"]] as const) {
        const p0 = usualShare(x0, b?.n ?? 0, appBefore ? { x: what === "5xx" ? appBefore.x5 : appBefore.x4, n: appBefore.n } : undefined);
        const lb = wilsonLower(x1, c.n);
        if (x1 >= R.minFailures && lb >= Math.max(R.errorFactor * p0, p0 + R.errorFloor) && binomialUpperTail(x1, c.n, p0) < R.alphaWatch / R.looks) {
          preDeployAnomaly ??= `${c.route} ${what} on ${x1} of ${c.n} requests`;
        }
      }
    }
  }

  // New error types: on the new release, never in the week before the deploy (only with a week of history to compare).
  const historyFrom = deployedAt - R.errorHistoryMs;
  const histHours: number[] = [];
  for (let h = Math.ceil(historyFrom / HOUR_MS) * HOUR_MS; h < deployHour; h += HOUR_MS) histHours.push(h);
  const hasHistory = [...store.rolledHours(appId, histHours).values()].some((n) => n > 0);
  const newErrors: { key: string; n: number }[] = [];
  if (hasHistory) {
    const seenBefore = store.hourlyKeys(appId, "error", historyFrom, deployHour);
    for (const e of store.statsFor(appId, "error", deployHour, deployedAt)) seenBefore.add(e.key);
    for (const e of store.statsFor(appId, "error", deployedAt, spanEnd, release)) {
      if (!seenBefore.has(e.key)) newErrors.push({ key: e.key, n: e.n });
    }
  }

  // A crash loop on the new release that began right after the deploy, with none on the previous one before it.
  const crashes = unexpectedRestarts(store, appId, spanEnd, Math.min(spanMs + MIN, RESILIENCE.loopLongMs)).filter((c) => c.release === release && c.ts >= deployedAt);
  let loop: LoopInput | undefined;
  const v = restartVerdict(store, appId, spanEnd);
  if (v?.loop && crashes.length >= RESILIENCE.loopShort && crashes[0]!.ts - deployedAt <= R.loopAfterDeployMs) {
    const before = unexpectedRestarts(store, appId, deployedAt, RESILIENCE.loopLongMs).filter((c) => c.release === previous);
    if (before.length < RESILIENCE.loopShort) {
      const counts = new Map<string, number>();
      for (const c of crashes) counts.set(c.text, (counts.get(c.text) ?? 0) + 1);
      const text = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      loop = { crashes: crashes.length, text, firstAt: crashes[0]!.ts };
    }
  }

  const collapse = store.openFindings(appId).some((f) => f.fingerprint === "health:traffic_collapse:");

  const input: JudgeInput = {
    spanMs,
    appAfter,
    ...(appBefore ? { appBefore } : {}),
    routes: routes.map((r) => ({ ...r })),
    ...(appLat && appUsual !== undefined ? { appLatency: { n: appLat.n, above: appLat.above, p95: appLat.p95, usual: appUsual } } : {}),
    newErrors,
    ...(loop ? { loop } : {}),
    ...(preDeployAnomaly ? { preDeployAnomaly } : {}),
    collapse,
    looks: R.looks,
  };
  return { release, previous, deployedAt, end: spanEnd, deploy: d, baseline, ...(baselineMs !== undefined ? { baselineMs } : {}), input, routes, crashes };
}

// ---- folds -----------------------------------------------------------------------

const SEVERITY_RANK = { info: 0, unknown: 1, warning: 2, critical: 3 } as const;

/**
 * Whether an open Rollout finding covers this signal at least as severely as
 * the finding that would fold into it (#133): only then does Health or
 * Resilience leave it out, so a fold never lowers an app's status.
 */
export function rolloutCovers(
  findings: readonly Finding[],
  what: { route: string; signal: SignalKind } | { errorKey: string } | { loop: true },
  severity: keyof typeof SEVERITY_RANK,
): boolean {
  return findings.some((f) => {
    if (f.agent !== "rollout" || f.state !== "open" || !f.fingerprint.startsWith("rollout:release:")) return false;
    if (SEVERITY_RANK[f.severity] < Math.max(SEVERITY_RANK.warning, SEVERITY_RANK[severity])) return false;
    const c = f.evidence.covers as Covers | undefined;
    if (!c) return false;
    if ("loop" in what) return c.loop === true;
    if ("errorKey" in what) return c.error_keys?.includes(what.errorKey) ?? false;
    return c.routes?.[what.route]?.includes(what.signal) ?? false;
  });
}
