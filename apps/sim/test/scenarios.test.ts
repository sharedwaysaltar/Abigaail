// Each scenario, replayed against the real Health and Watchdog agents with a
// simulated clock, produces exactly its expected findings within the times
// the scenario table promises, and nothing else.

import { appendFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { health, resilience, watchdog, type Agent } from "@abigaail/server";
import { mins, plan, replay, scenario, scenariosFor, WARMUP_MS, type AppKind, type Scenario, type Tracker } from "@abigaail/sim";
import { BUSY, cleanup, QUIET, seededStore } from "./simfx.js";

const MIN = 60_000;

afterAll(cleanup);

function run(app: AppKind, names: string[], start: number) {
  return runPlan(app, plan(app, names), start);
}

function runPlan(app: AppKind, planned: ReturnType<typeof plan>, start: number) {
  const s = seededStore(app, start);
  try {
    const r = replay({ store: s.store, appId: s.appId, app, plan: planned, start });
    const results = r.tracker.results(r.endedAt);
    const log = (line: string) => (process.env.SIM_TIMINGS ? appendFileSync(process.env.SIM_TIMINGS, `${line}\n`) : undefined);
    for (const x of results) log(`${app} ${start === QUIET ? "quiet" : "busy"} ${x.scenario} ${x.fingerprint} ${x.status} show=${x.showMs === undefined ? "-" : mins(x.showMs)} resolve=${x.resolveMs === undefined ? "-" : mins(x.resolveMs)} ${x.detail}`);
    for (const p of r.problems) log(`${app} problem ${p.kind}: ${p.detail}`);
    return { results, problems: r.problems };
  } finally {
    s.close();
  }
}

for (const app of ["node", "next"] as const) {
  describe(`demo-${app}`, () => {
    // The quietest hour is the hardest case: the least evidence per window.
    for (const s of scenariosFor(app)) {
      it(`${s.name} (quiet hour)`, () => {
        const { results, problems } = run(app, [s.name], QUIET);
        expect(problems).toEqual([]);
        expect(results.filter((x) => x.status !== "pass")).toEqual([]);
      }, 120_000);
    }

    if (app === "node") {
      it("dependency with linking off (Node 22's default): two findings, the route naming localhost as likely cause", () => {
        const base = scenario(app, "dependency")!;
        // Unlinked, Health cannot prove the route's failures came from localhost, so it does not fold.
        const unlinked: Scenario = {
          ...base,
          expect: [
            { ...base.expect[0]!, summary: ["localhost is failing"] },
            { fingerprint: "health:server_errors:/checkout", severity: "critical", summary: ["/checkout returns 5xx"], showWithinMs: 6 * MIN, resolveWithinMs: 21 * MIN },
          ],
        };
        const s = seededStore(app, QUIET);
        try {
          const r = replay({ store: s.store, appId: s.appId, app, plan: [{ scenario: unlinked, at: WARMUP_MS }], start: QUIET, linkOutbound: false });
          expect(r.problems).toEqual([]);
          expect(r.tracker.results(r.endedAt).filter((x) => x.status !== "pass")).toEqual([]);
          // From confirmation until localhost's failures leave Health's 5-min window, the route
          // finding names it as the likely cause. Later the route is still judged on its 15-min
          // window, with no failing dependency left to name.
          const faultEnd = QUIET + WARMUP_MS + base.faultMs;
          const emissions = r.tracker.emissionsOf("health:server_errors:/checkout");
          const confirmed = emissions.find((e) => e.severity === "critical")!;
          const whileFailing = emissions.filter((e) => e.at >= confirmed.at && e.at <= faultEnd + 5 * MIN);
          expect(whileFailing.length).toBeGreaterThan(3);
          for (const e of whileFailing) {
            expect(e.cause).toMatch(/^At the same time localhost failed \d+ of \d+ calls; likely related \(calls are not linked on this Node version\)\.$/);
          }
        } finally {
          s.close();
        }
      }, 120_000);

      it("a deploy after which no visitor gets through is a traffic collapse within about 7 min of the boot", () => {
        const proxyBroken: Scenario = {
          name: "deploy-breaks-proxy",
          apps: ["node"],
          description: "Clean restart on sim-r2; the proxy in front is broken, so no human request arrives for 12 min.",
          steps: [
            { at: 0, action: { stop: true } },
            { at: 2_000, action: { humans: false } },
            { at: 2_000, action: { start: { release: "sim-r2" } } },
            { at: 12 * MIN, action: { humans: true } },
          ],
          faultMs: 12 * MIN,
          expect: [
            { fingerprint: "health:traffic_collapse:", severity: "critical", summary: ["is up but traffic collapsed"], showWithinMs: 2_000 + 7 * MIN, resolveWithinMs: 7 * MIN },
            { fingerprint: "health:deploy:sim-r2", severity: "info", summary: ["deployed release sim-r2 (was sim-r1)"], showWithinMs: 3 * MIN, resolveWithinMs: 19 * MIN },
          ],
          allowed: ["health:too_little_traffic:"],
        };
        const { results, problems } = runPlan(app, [{ scenario: proxyBroken, at: WARMUP_MS }], QUIET);
        expect(problems).toEqual([]);
        expect(results.filter((x) => x.status !== "pass")).toEqual([]);
        // Not before the 5 minutes since the boot (plus Health's 45 s lag).
        expect(results.find((x) => x.fingerprint === "health:traffic_collapse:")!.showMs).toBeGreaterThan(5 * MIN + 45_000);
      }, 120_000);

      it("a normal restart with traffic ramping up over 5 min is not a traffic collapse", () => {
        const ramp: Scenario = {
          name: "restart-ramp",
          apps: ["node"],
          description: "Clean stop, 2 min down, start on the same release; visitors return over 5 min.",
          steps: [
            { at: 0, action: { stop: true } },
            { at: 0, action: { humans: 0 } },
            { at: 2 * MIN, action: { start: {} } },
            ...[0.2, 0.4, 0.6, 0.8, 1].map((share, i) => ({ at: 2 * MIN + i * MIN, action: { humans: share } })),
          ],
          faultMs: 15 * MIN,
          expect: [],
          forbid: ["health:traffic_collapse:"],
          forbidMs: 20 * MIN,
        };
        const { results, problems } = runPlan(app, [{ scenario: ramp, at: WARMUP_MS }], QUIET);
        expect(problems).toEqual([]);
        expect(results).toEqual([]);
      }, 120_000);

      it("blocking-route at the busy hour, block events arriving up to 30 s after their requests: loop_blocked and no health:latency for /docs (#125)", () => {
        // The demo's metrics intervals end 20 or 25 s into each 30 s: the phases that showed the race.
        for (const metricsPhaseMs of [20_000, 25_000]) {
          const s = seededStore(app, BUSY);
          try {
            const r = replay({ store: s.store, appId: s.appId, app, plan: plan(app, ["blocking-route"]), start: BUSY, metricsPhaseMs });
            expect(r.problems).toEqual([]);
            expect(r.tracker.results(r.endedAt).map((x) => [x.fingerprint, x.status])).toEqual([["resilience:loop_blocked:/docs", "pass"]]);
          } finally {
            s.close();
          }
        }
      }, 300_000);

      it("bad-deploy: Health reports /checkout as fast as without Rollout, and never while Rollout's critical covers it (#133)", () => {
        const runWith = (agents?: readonly Agent[]) => {
          const s = seededStore(app, QUIET);
          try {
            const r = replay({ store: s.store, appId: s.appId, app, plan: plan(app, ["bad-deploy"]), start: QUIET, ...(agents ? { agents } : {}) });
            return { tracker: r.tracker, rollout: s.store.findingHistory(s.appId).find((f) => f.fingerprint === "rollout:release:sim-r2") };
          } finally {
            s.close();
          }
        };
        const firstCritical = (t: Tracker, fp: string) => t.emissionsOf(fp).find((e) => e.severity === "critical")?.at;
        const withRollout = runWith();
        const today = runWith([health, watchdog, resilience]);
        // As fast as today: Rollout changes nothing before it takes over.
        expect(firstCritical(withRollout.tracker, "health:server_errors:/checkout")).toBe(firstCritical(today.tracker, "health:server_errors:/checkout"));
        expect(withRollout.tracker.emissionsOf("health:new_error:TypeError /checkout")[0]!.at).toBe(today.tracker.emissionsOf("health:new_error:TypeError /checkout")[0]!.at);
        // Never twice: from the run after Rollout's first critical until its last emission, Health is silent about /checkout.
        const rollout = withRollout.tracker.emissionsOf("rollout:release:sim-r2");
        const from = rollout.find((e) => e.severity === "critical")!.at;
        const to = rollout.at(-1)!.at;
        expect(withRollout.rollout!.evidence.covers).toMatchObject({ routes: { "/checkout": ["errors"] }, error_keys: ["TypeError /checkout"] });
        for (const fp of ["health:server_errors:/checkout", "health:new_error:TypeError /checkout"]) {
          expect(withRollout.tracker.emissionsOf(fp).filter((e) => e.at > from + MIN && e.at <= to)).toEqual([]);
        }
      }, 300_000);

      it("error-burst across an hour boundary: the rollup of its own hour does not make it old news", () => {
        // Starts at 03:45, so the fault (03:51-03:56) is rolled up at 04:00 while still in the window.
        const { results, problems } = run(app, ["error-burst"], QUIET + 15 * 60_000);
        expect(problems).toEqual([]);
        expect(results.filter((x) => x.status !== "pass")).toEqual([]);
      }, 120_000);
    }

    for (const [label, start] of [["quiet", QUIET], ["busy", BUSY]] as const) {
      it(`all scenarios in one run, overlapping as \`run all\` schedules them (${label} hour)`, () => {
        const { results, problems } = run(app, ["all"], start);
        expect(problems).toEqual([]);
        expect(results.filter((x) => x.status !== "pass")).toEqual([]);
      }, 300_000);
    }
  });
}
