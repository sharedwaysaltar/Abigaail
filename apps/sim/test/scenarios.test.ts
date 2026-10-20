// Each scenario, replayed against the real Health and Watchdog agents with a
// simulated clock, produces exactly its expected findings within the times
// the scenario table promises, and nothing else.

import { appendFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { mins, plan, replay, scenariosFor, type AppKind } from "@abigaail/sim";
import { BUSY, cleanup, QUIET, seededStore } from "./simfx.js";

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
