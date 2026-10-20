// Each scenario, replayed against the real Health and Watchdog agents with a
// simulated clock, produces exactly its expected findings within the times
// the scenario table promises, and nothing else.

import { appendFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { mins, plan, replay, scenario, scenariosFor, WARMUP_MS, type AppKind, type Scenario } from "@abigaail/sim";
import { BUSY, cleanup, QUIET, seededStore } from "./simfx.js";

const MIN = 60_000;

afterAll(cleanup);

function run(app: AppKind, names: string[], start: number) {
  const s = seededStore(app, start);
  try {
    const r = replay({ store: s.store, appId: s.appId, app, plan: plan(app, names), start });
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
