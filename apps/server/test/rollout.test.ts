// Rollout Safety (agent 5, DECISIONS #131-#133): a release judged against the
// same routes at the same hours before its deploy, on its own rows only; a
// verdict that holds 2 runs before it is reported; and the folds that keep
// Health's and Resilience's findings from repeating it, never lowering status.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { health, resilience, rollout, thresholds } from "@abigaail/server";
import { HOUR_MS, type Severity } from "@abigaail/store";
import { releaseInput, ROLLOUT as R } from "@abigaail/insights";
import { Fx, MIN, NOW } from "./agentfx.js";

let fx: Fx;
beforeEach(() => {
  fx = new Fx();
});
afterEach(() => fx.close());

/** 13:50 UTC: 40 min before NOW, so the release spans the 13:00 and 14:00 hours. */
const DEPLOY = NOW - 40 * MIN;
const END = NOW - 45_000;
/** 20 requests a minute; /checkout carries 15% of them. */
const mix = (status = (_route: string, _i: number) => 200, duration = 50) => (i: number) => {
  const route = i % 20 < 3 ? "/checkout" : "/";
  return { route, status: status(route, i), duration };
};

/** Four weeks of normal for the 13:00 and 14:00 hours, the old release's last half hour, then the deploy. */
function deployed(release = "r2"): void {
  for (const at of [NOW - HOUR_MS, NOW]) fx.baselineWeeks(at, 4, (h) => fx.requests(h, h + HOUR_MS, 1200, mix()));
  fx.requests(DEPLOY - 30 * MIN, DEPLOY, 600, mix());
  fx.start(DEPLOY, { release });
}

/** The new release's own traffic since the deploy. */
function after(status?: (route: string, i: number) => number, duration?: number, release = "r2"): void {
  fx.requests(DEPLOY + 2_000, END, Math.round((END - DEPLOY) / MIN) * 20, mix(status, duration), release);
}

/** Two runs a minute apart, recorded as the runner does: the verdict reported by the second. */
function twoRuns() {
  fx.now = NOW - MIN;
  fx.runAndRecord(rollout);
  fx.now = NOW;
  fx.runAndRecord(rollout);
  return fx.store.openFindings(fx.appId).find((f) => f.agent === "rollout")!;
}

describe("judging a release", () => {
  it("a route the release broke: recommend rollback (critical), with its numbers and what it covers", () => {
    deployed();
    after((route, i) => (route === "/checkout" && i % 2 === 0 ? 500 : 200));
    const first = fx.run(rollout)[0]!;
    // One look is not enough: a verdict must hold on 2 runs in a row.
    expect(first).toMatchObject({ severity: "info", evidence: { verdict: "too_little", raw: "rollback" } });
    const f = twoRuns();
    expect(f).toMatchObject({ fingerprint: "rollout:release:r2", severity: "critical", evidence: { verdict: "rollback", previous: "r1", baseline: "hour-of-week" } });
    expect(f.summary).toMatch(/^Recommend rollback: release r2 \(replacing r1\) \/checkout returns 5xx on \d+% of requests/);
    expect(f.cause).toMatch(/impact, a route carrying at least 10% of the usual traffic fails/);
    expect(f.evidence.covers).toEqual({ routes: { "/checkout": ["errors"] }, error_keys: [], loop: false });
  });

  it("an unchanged release looks fine (info, a fact)", () => {
    deployed();
    after();
    const f = twoRuns();
    expect(f).toMatchObject({ severity: "info", resolves: "fact", evidence: { verdict: "fine" } });
    expect(f.summary).toMatch(/^Release r2 looks fine: \d+ requests over 39 min since the deploy at 13:50 UTC \(replacing r1\), no route worse than the same hours of the week/);
  });

  it("a rolling deploy: the old release's rows after the deploy never count against the new one", () => {
    deployed();
    after();
    // An old process still answering, and failing, after the deploy.
    fx.requests(DEPLOY + 2_000, END, 400, mix((route) => (route === "/checkout" ? 500 : 200)), "r1");
    expect(twoRuns().evidence.verdict).toBe("fine");
  });

  it("the new release is never its own baseline: hours from the deploy on are left out", () => {
    // Deployed 23 h 50 min ago with no weekly history, only daily: the daily slot of the
    // latest hour is the deploy's own hour, which holds the new release's failures.
    const deploy = NOW - (23 * 60 + 50) * MIN;
    const deployHour = Math.floor(deploy / HOUR_MS) * HOUR_MS;
    for (let d = 1; d <= 3; d++) for (let h = deployHour - d * 24 * HOUR_MS; h < NOW - d * 24 * HOUR_MS; h += HOUR_MS) {
      fx.requests(h, h + HOUR_MS, 120, mix());
      fx.store.rollupHour(fx.appId, h);
    }
    fx.requests(deploy - 10 * MIN, deploy, 20, mix());
    fx.start(deploy, { release: "r2" });
    fx.requests(deploy + 2_000, deployHour + HOUR_MS, 100, mix(() => 500), "r2");
    fx.store.rollupHour(fx.appId, deployHour);
    const data = releaseInput(fx.store, fx.appId, END)!;
    expect(data.baseline).toBe("daily");
    // Every failure in the baseline is from before the deploy: none.
    expect(data.input.appBefore!.x5).toBe(0);
  });

  it("a release named \"unknown\" (ABIGAAIL_RELEASE not set) is never judged", () => {
    deployed("unknown");
    after(undefined, undefined, "unknown");
    expect(fx.run(rollout)).toEqual([]);
  });

  it("the latency it calls rollback-worthy is what Health calls critical", () => {
    expect(R.latencyRollbackRatio).toBe(thresholds.HEALTH.latencyCriticalRatio);
  });
});

// ---- folds ---------------------------------------------------------------------------

/** A Rollout finding as the agent records it, covering what is given. */
function plant(severity: Severity, covers: { routes?: Record<string, string[]>; error_keys?: string[]; loop?: boolean }): void {
  fx.store.recordRun(
    { agent: "rollout", started_at: fx.now - 100, finished_at: fx.now, outcome: "ok", apps_ok: 1, apps_failed: 0 },
    [{
      app_id: fx.appId, agent: "rollout", fingerprint: "rollout:release:r2", signal: "release", severity, summary: "planted", action: "planted",
      evidence: { verdict: severity === "critical" ? "rollback" : "watch", covers: { routes: {}, error_keys: [], loop: false, ...covers } },
    }],
    [fx.appId],
  );
}
const healthSignals = () => fx.run(health).map((f) => `${f.signal}:${f.subject}:${f.severity}`).sort();

describe("Health folds into Rollout's finding (#133)", () => {
  beforeEach(() => {
    // /checkout fails badly (Health: critical); /tiny fails too, on a route Rollout does not judge.
    fx.requests(NOW - 5 * MIN, END, 100, (i) => ({ route: "/checkout", status: i % 2 ? 500 : 200 }));
    fx.requests(NOW - 5 * MIN, END, 10, () => ({ route: "/tiny", status: 500 }));
    fx.error(NOW - 2 * MIN, "TypeError", "/checkout", undefined);
    for (let i = 0; i < 3; i++) fx.error(NOW - 2 * MIN + i * 1_000, "TypeError", "/checkout");
  });

  it("before Rollout reports it, Health reports the route as today", () => {
    expect(healthSignals()).toEqual(expect.arrayContaining(["server_errors:/checkout:critical", "server_errors:/tiny:critical", "new_error:TypeError /checkout:warning"]));
  });

  it("once a critical Rollout finding covers it, the route and its new error type leave Health; /tiny stays", () => {
    plant("critical", { routes: { "/checkout": ["errors"] }, error_keys: ["TypeError /checkout"] });
    const s = healthSignals();
    expect(s).not.toContain("server_errors:/checkout:critical");
    expect(s.some((x) => x.startsWith("new_error:TypeError /checkout"))).toBe(false);
    expect(s).toContain("server_errors:/tiny:critical");
  });

  it("a fold never lowers status: a warning (watch) does not take over a critical route", () => {
    plant("warning", { routes: { "/checkout": ["errors"] } });
    expect(healthSignals()).toContain("server_errors:/checkout:critical");
  });

  it("covering another signal of the route (latency) does not fold its errors", () => {
    plant("critical", { routes: { "/checkout": ["latency"] } });
    expect(healthSignals()).toContain("server_errors:/checkout:critical");
  });
});

describe("Resilience folds a crash loop after a deploy into Rollout's finding (#133)", () => {
  const A = "aaaaaaaaaaaa";
  beforeEach(() => {
    for (const ago of [12, 9, 6, 3]) fx.start(NOW - ago * MIN, { instance: A });
  });

  it("reports the loop until Rollout covers it, then leaves it to Rollout", () => {
    expect(fx.run(resilience).filter((f) => f.signal === "restart").map((f) => f.severity)).toEqual(["critical"]);
    plant("critical", { loop: true });
    expect(fx.run(resilience).filter((f) => f.signal === "restart")).toEqual([]);
  });

  it("a Rollout finding without the loop folds nothing", () => {
    plant("critical", { routes: { "/checkout": ["errors"] } });
    expect(fx.run(resilience).filter((f) => f.signal === "restart")).toHaveLength(1);
  });
});

describe("Health after a deploy inside its windows (#133)", () => {
  beforeEach(() => {
    // /checkout failed on r1 until 6 min ago; the release before the deploy.
    fx.requests(NOW - 14 * MIN, NOW - 6 * MIN, 120, (i) => ({ route: "/checkout", status: i % 2 ? 500 : 200 }));
  });

  it("without a deploy, the failures are judged as usual", () => {
    expect(healthSignals()).toContain("server_errors:/checkout:critical");
  });

  it("a deploy (or a rollback) 5 min ago: what the old release did is no longer judged against the new one", () => {
    fx.start(NOW - 5 * MIN, { release: "r2" });
    fx.requests(NOW - 5 * MIN + 2_000, END, 60, { route: "/checkout" }, "r2");
    expect(healthSignals().filter((s) => s.startsWith("server_errors:"))).toEqual([]);
  });

  it("the new release's own failures after the deploy are still reported at once", () => {
    fx.start(NOW - 5 * MIN, { release: "r2" });
    fx.requests(NOW - 5 * MIN + 2_000, END, 60, (i) => ({ route: "/checkout", status: i % 2 ? 500 : 200 }), "r2");
    const f = fx.run(health).find((x) => x.signal === "server_errors")!;
    expect(f.severity).toBe("critical");
    expect(f.summary).toMatch(/in the last 4 min\)/);
  });
});

describe("Resilience after a rollback (#133)", () => {
  it("the replaced release's crash loop ends with the deploy that replaced it", () => {
    const A = "aaaaaaaaaaaa";
    fx.requests(NOW - 20 * MIN, NOW - 13 * MIN, 20, { route: "/" });
    for (const ago of [12, 10, 8, 6]) fx.start(NOW - ago * MIN, { instance: A, release: "r2" });
    expect(fx.run(resilience).filter((f) => f.signal === "restart").map((f) => f.severity)).toEqual(["critical"]);
    // Rolled back to r1: a deploy of r1, replacing r2.
    fx.lifecycle(NOW - 4 * MIN + 30_000, "shutdown", "r2", { instance: A });
    fx.start(NOW - 4 * MIN, { instance: A, release: "r1" });
    expect(fx.run(resilience).filter((f) => f.signal === "restart")).toEqual([]);
  });
});
