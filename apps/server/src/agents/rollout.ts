// Rollout Safety (agent 5): did the latest release make the app worse
// (docs/AGENTS.md)? The same routes at the same hours of the week, before vs
// after the deploy, with exact tests corrected for every test and every look;
// new error types, routes newly failing or gone quiet, and crash loops right
// after a deploy. One finding per release, whose verdict is "recommend
// rollback" only with high impact and high confidence. The rules live in
// @abigaail/insights (rollout.ts) because Health and Resilience fold into it
// and the Releases view shows the same numbers.

import type { App } from "@abigaail/store";
import {
  heldVerdict,
  humanDuration,
  judge,
  releaseInput,
  type Covers,
  type Judgement,
  type ReleaseData,
  type Signal,
  type Verdict,
} from "@abigaail/insights";
import { ROLLOUT as R, SCHEDULE } from "./thresholds.js";
import type { Agent, AgentContext, AgentFinding } from "./types.js";

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const hhmm = (ts: number) => `${new Date(ts).toISOString().slice(11, 16)} UTC`;
const n = (x: unknown) => Number(x);

const SEVERITY = { rollback: "critical", watch: "warning", fine: "info", too_little: "info" } as const;
/** A finding from more than this long ago is not "the run before". */
const FRESH_MS = 2.5 * SCHEDULE.rollout.everyMs;

const BASELINE_TEXT: Record<ReleaseData["baseline"], string> = {
  "hour-of-week": "the same hours of the week over recent weeks",
  daily: "the same hours on recent days",
  previous_release: "the previous release's last hours (no hour-of-week history yet)",
  none: "nothing (no history before the deploy)",
};

/** One significant signal in words. */
function describe(s: Signal): string {
  const d = s.detail;
  switch (s.kind) {
    case "errors":
      return `${s.route} returns 5xx on ${pct(n(d.share))} of requests (${d.failures} of ${d.requests}), usually ${pct(n(d.usual_share))}`;
    case "client_errors":
      return `${s.route} answers 4xx on ${pct(n(d.share))} of requests (${d.failures} of ${d.requests}${n(d.not_found) ? `, ${d.not_found} of them 404` : ""}), usually ${pct(n(d.usual_share))}`;
    case "latency":
      return `${s.route} p95 is ${ms(n(d.p95))}, ${(n(d.p95) / n(d.usual_p95)).toFixed(1)}× its usual ${ms(n(d.usual_p95))} (${d.above_usual} of ${d.requests} requests slower than usual)`;
    case "quiet":
      return `${s.route} went quiet: ${d.requests} requests against about ${d.expected} usually`;
    case "app_latency":
      return `${pct(n(d.above_usual) / n(d.requests))} of all requests are slower than the app's usual p95 of ${ms(n(d.usual_p95))}`;
    case "new_error": {
      const key = String(d.error);
      const space = key.indexOf(" ");
      const route = key.slice(space + 1);
      return `new error ${key.slice(0, space)}${route && route !== "-" ? ` on ${route}` : ""} (${d.count} times, not seen in the week before)`;
    }
    case "loop":
      return `crashed ${d.crashes} times since the deploy; most often: ${d.cause}`;
  }
}

/** The worst signals first: those behind the rollback, then by extra failures. */
function ranked(j: Judgement): Signal[] {
  const order = { loop: 0, errors: 1, client_errors: 2, quiet: 3, latency: 4, app_latency: 5, new_error: 6 } as const;
  return j.signals.filter((s) => s.significant).sort((a, b) => Number(b.impact) - Number(a.impact) || order[a.kind] - order[b.kind] || b.excess - a.excess);
}

const RULE_TEXT: Record<string, string> = {
  crash_loop: "a crash loop that began with this release",
  route_failing: `a route carrying at least ${pct(R.routeTrafficShare)} of the usual traffic fails for at least ${pct(R.routeFailShare)} of its requests`,
  excess_failures: `extra failures are at least ${pct(R.excessShare)} of all requests since the deploy`,
  route_slow: `a route carrying at least ${pct(R.routeTrafficShare)} of the usual traffic is ${R.latencyRollbackRatio}× as slow as usual`,
  app_slow: `at least ${pct(R.appSlowShare)} of all requests are slower than usual`,
  route_quiet: `a route carrying at least ${pct(R.routeTrafficShare)} of the usual traffic went quiet`,
};

function finding(app: App, data: ReleaseData, j: Judgement, verdict: Verdict, covers: Covers): AgentFinding {
  const { release, previous, deployedAt } = data;
  const since = `since the deploy at ${hhmm(deployedAt)}`;
  const signals = ranked(j);
  const said = signals.slice(0, 4).map(describe);
  const more = signals.length > 4 ? `; and ${signals.length - 4} more` : "";
  const corrected = j.confidence.corrected;
  const pText = corrected !== null && corrected < 1 ? `p ${corrected < 1e-6 ? "< 0.000001" : `≈ ${corrected.toPrecision(2)}`} after correcting for ${j.tests} tests over ${R.looks} looks` : null;
  let summary: string;
  let cause: string | undefined;
  let action: string;
  switch (verdict) {
    case "rollback":
      summary = `Recommend rollback: release ${release} (replacing ${previous}) ${said.join("; ")}${more}, ${since}.`;
      cause = `The change started with release ${release}: impact, ${RULE_TEXT[j.impact.rule ?? ""] ?? "high"}${pText ? `; confidence, ${pText}` : ""}, and ${previous} was normal before the deploy.`;
      action = `Roll back to ${previous}, then look at what changed between ${previous} and ${release}${signals[0]?.route ? ` on ${signals[0].route}` : ""}.`;
      break;
    case "watch": {
      summary = `Watch release ${release} (replacing ${previous}): ${said.join("; ")}${more}, ${since}.`;
      const gate = !j.impact.met ? "the impact is below the rollback bar" : (j.confidence.why ?? "it has not held long enough");
      cause = `Changed with release ${release}, compared with ${BASELINE_TEXT[data.baseline]}; not a rollback because ${gate}.`;
      action = `Look at what changed between ${previous} and ${release}${signals[0]?.route ? ` on ${signals[0].route}` : ""}; Rollout keeps comparing for ${humanDuration(R.judgeMs)} after the deploy.`;
      break;
    }
    case "fine":
      summary = `Release ${release} looks fine: ${data.input.appAfter} requests over ${humanDuration(data.input.spanMs)} ${since} (replacing ${previous}), no route worse than ${BASELINE_TEXT[data.baseline]}.`;
      action = "Nothing to do.";
      break;
    default: {
      // Say which bar it has not reached yet.
      const needs = data.input.spanMs < R.minObservedMs
        ? `nothing is judged before ${humanDuration(R.minObservedMs)}`
        : data.input.appAfter < R.fineMinRequests || data.input.spanMs < R.fineMinMs
          ? `"looks fine" needs ${humanDuration(R.fineMinMs)} and ${R.fineMinRequests} requests`
          : `a route needs ${R.minRequests} requests to be compared`;
      summary = `Too little traffic to judge release ${release} yet: ${data.input.appAfter} requests in ${humanDuration(data.input.spanMs)} ${since} (replacing ${previous}); ${needs}.`;
    }
      action = "Nothing to do. Health still watches the app; Rollout judges the release once there is enough traffic.";
  }
  const dependencies = data.routes.filter((r) => r.dependency).map((r) => ({ route: r.route, host: r.dependency!.host, requests: r.dependency!.requests }));
  return {
    signal: "release",
    subject: release,
    severity: SEVERITY[verdict],
    summary,
    ...(cause ? { cause } : {}),
    action,
    evidence: {
      release,
      previous,
      deployed_at: deployedAt,
      verdict,
      raw: j.raw,
      requests: data.input.appAfter,
      span_ms: data.input.spanMs,
      baseline: data.baseline,
      ...(data.baselineMs !== undefined ? { baseline_ms: data.baselineMs } : {}),
      tests: j.tests,
      looks: R.looks,
      impact: j.impact,
      confidence: j.confidence,
      covers,
      signals: signals.slice(0, 12).map((s) => ({ kind: s.kind, route: s.route ?? null, impact: s.impact, p: s.p ?? null, corrected: s.corrected ?? null, ...s.detail })),
      ...(dependencies.length ? { explained_by_dependency: dependencies } : {}),
      ...(data.input.preDeployAnomaly ? { before_deploy: data.input.preDeployAnomaly } : {}),
      commit: data.deploy.commit_sha,
      previous_release: data.deploy.previous_release,
      lockfile_hash: data.deploy.lockfile_hash,
    },
    fact: verdict === "fine" || verdict === "too_little",
  };
}

function forApp(ctx: AgentContext, app: App): AgentFinding[] {
  if (app.disabled_at !== null) return [];
  const data = releaseInput(ctx.store, app.id, ctx.windowEnd);
  if (!data) return [];
  const j = judge(data.input);
  // A verdict, or a change of verdict, must hold on 2 runs in a row (#132).
  const prev = ctx.store.openFindings(app.id).find((f) => f.fingerprint === `rollout:release:${data.release}`);
  const prevVerdict = prev?.evidence.verdict as Verdict | undefined;
  const previous = !prev || !prevVerdict
    ? undefined
    : ctx.now - prev.last_seen <= FRESH_MS
      ? { raw: prev.evidence.raw as Verdict, reported: prevVerdict }
      : { raw: "stale" as Verdict, reported: prevVerdict };
  const verdict = heldVerdict(j.raw, previous);
  // What Health and Resilience may fold: this run's signals while they back the verdict, else the last run's.
  const empty: Covers = { routes: {}, error_keys: [], loop: false };
  const covers = verdict !== "watch" && verdict !== "rollback"
    ? empty
    : j.raw === "watch" || j.raw === "rollback"
      ? j.covers
      : ((prev?.evidence.covers as Covers | undefined) ?? empty);
  return [finding(app, data, j, verdict, covers)];
}

export const rollout: Agent = {
  name: "rollout",
  ...SCHEDULE.rollout,
  forApp,
};
