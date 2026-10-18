import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { health } from "@abigaail/server";
import { HOUR_MS } from "@abigaail/store";
import { Fx, MIN, signals } from "./agentfx.js";

let fx: Fx;
beforeEach(() => {
  fx = new Fx();
});
afterEach(() => fx.close());

/** End of the windows Health judges. */
const E = () => fx.now - 45_000;
/** Spread over the last 4 minutes: inside both the 5- and the 15-minute windows. */
const recent = (count: number, r: Parameters<Fx["requests"]>[3] = {}) => fx.requests(E() - 4 * MIN, E() - 1_000, count, r);
const only = (signal: string) => fx.run(health).filter((f) => f.signal === signal);

describe("evidence before alarm", () => {
  it("too little traffic is grey, and 1 failure in 2 requests is not an outage", () => {
    recent(2, (i) => ({ status: i === 0 ? 500 : 200 }));
    expect(signals(fx.run(health))).toEqual(["too_little_traffic::unknown"]);
  });

  it("low-traffic staging does not flap: 4 of 6 failing is below the 5-failure minimum", () => {
    recent(6, (i) => ({ route: "/login", status: i < 4 ? 500 : 200 }));
    expect(only("server_errors")).toEqual([]);
  });

  it("enough traffic and no problems: no findings at all (green)", () => {
    recent(60, { route: "/a" });
    expect(fx.run(health)).toEqual([]);
  });
});

describe("server errors per route", () => {
  it("10 of 40 failing with no baseline is critical, with numbers in the summary", () => {
    recent(40, (i) => ({ route: "/api/checkout", status: i % 4 === 0 ? 503 : 200 }));
    const [f] = only("server_errors");
    expect(f).toMatchObject({ subject: "/api/checkout", severity: "critical", evidence: { failures: 10, requests: 40, baseline: "none" } });
    expect(f!.summary).toBe("/api/checkout returns 5xx for 25% of requests (10 of 40 in the last 5 min); no baseline yet.");
  });

  it("uses the Wilson lower bound: 5 of 40 (12.5%) is a warning, not critical", () => {
    recent(40, (i) => ({ route: "/w", status: i % 8 === 0 ? 500 : 200 }));
    expect(only("server_errors")[0]).toMatchObject({ severity: "warning" });
    expect(only("server_errors")[0]!.evidence.wilson_lower).toBeCloseTo(0.054, 2);
  });

  it("a route that normally fails 10% is not alarming at 12%", () => {
    fx.baselineWeeks(E(), 4, (h) => fx.requests(h, h + HOUR_MS, 100, (i) => ({ route: "/flaky", status: i % 10 === 0 ? 500 : 200 })));
    recent(100, (i) => ({ route: "/flaky", status: i % 8 === 0 ? 500 : 200 }));
    expect(only("server_errors")).toEqual([]);
  });

  it("4xx is not 5xx: a 401 spike is an auth warning, not an outage", () => {
    recent(60, (i) => ({ route: "/login", status: i % 2 ? 401 : 200 }));
    expect(signals(fx.run(health))).toEqual(["auth_failures:/login:warning"]);
  });

  it("bots and scanner probes never count towards health", () => {
    recent(40, { route: "/a" });
    recent(40, { route: "/a", status: 500, bot: "crawler" });
    recent(40, { route: "/a", status: 500, bot: "automation" });
    recent(40, { route: "unmatched", status: 500, flags: ["scanner_path"] });
    expect(fx.run(health)).toEqual([]);
  });

  it("weights sampled requests by 1/sample_rate in the evidence", () => {
    recent(40, (i) => ({ route: "/s", status: i % 4 === 0 ? 500 : 200, sample_rate: 0.25 }));
    expect(only("server_errors")[0]!.evidence).toMatchObject({ requests: 40, estimated_requests: 160, estimated_failures: 40 });
  });

  it("red only after 2 runs, and recovers only after 3 good runs", () => {
    fx.store.recordRun({ agent: "watchdog", started_at: 0, finished_at: 1, outcome: "ok", apps_ok: 1, apps_failed: 0 }, [], []);
    recent(40, (i) => ({ route: "/x", status: i % 4 === 0 ? 500 : 200 }));
    expect(fx.runAndRecord(health)).toBe("amber");
    fx.now += MIN;
    expect(fx.runAndRecord(health)).toBe("red");
    // The failures age out of both windows; healthy traffic continues.
    fx.now += 20 * MIN;
    recent(40, { route: "/x" });
    const after = [fx.runAndRecord(health)];
    for (let i = 0; i < 2; i++) {
      fx.now += MIN;
      recent(10, { route: "/x" });
      after.push(fx.runAndRecord(health));
    }
    expect(after).toEqual(["red", "red", "green"]);
  });
});

describe("latency per route against its own normal", () => {
  const normal = (route: string, ms: number) =>
    fx.baselineWeeks(E(), 4, (h) => fx.requests(h, h + HOUR_MS, 60, (i) => ({ route, duration: ms + (i % 5) })));

  it("an AI chat route at 8.5 s with an 8 s normal is fine", () => {
    normal("/api/chat", 8000);
    recent(30, { route: "/api/chat", duration: 8500 });
    expect(only("latency")).toEqual([]);
  });

  it("a profile page at 1.2 s with a 400 ms normal is critical", () => {
    normal("/profile", 400);
    recent(30, { route: "/profile", duration: 1200 });
    const [f] = only("latency");
    expect(f).toMatchObject({ subject: "/profile", severity: "critical" });
    expect(f!.summary).toMatch(/^\/profile p95 is 1\.2 s, 3\.0× its usual 404 ms for Wednesday 14:00 UTC; 30 requests in 5 min\.$/);
  });

  it("2 ms -> 6 ms is not an alert (absolute floor)", () => {
    // A steady 2 ms: 6 ms is 3× (above the critical ratio) and far outside the spread.
    fx.baselineWeeks(E(), 4, (h) => fx.requests(h, h + HOUR_MS, 60, { route: "/fast", duration: 2 }));
    recent(30, { route: "/fast", duration: 6 });
    expect(only("latency")).toEqual([]);
  });

  it("with no baseline yet, a p95 of 2.4 s is a warning that says so", () => {
    recent(30, { route: "/new", duration: 2400 });
    const [f] = only("latency");
    expect(f).toMatchObject({ severity: "warning", evidence: { baseline: "none" } });
    expect(f!.summary).toMatch(/no baseline yet/);
  });

  it("falls back to the same hour on recent days when weeks are missing", () => {
    for (let d = 1; d <= 3; d++) {
      const h = Math.floor(E() / HOUR_MS) * HOUR_MS - d * 24 * HOUR_MS;
      fx.requests(h, h + HOUR_MS, 60, { route: "/p", duration: 300 });
      fx.store.rollupHour(fx.appId, h);
    }
    recent(30, { route: "/p", duration: 1000 });
    expect(only("latency")[0]).toMatchObject({ severity: "critical", evidence: { baseline: "daily" } });
  });
});

describe("dependencies name the cause", () => {
  it("Stripe timing out so /api/checkout fails: one finding, not two", () => {
    const ids = recent(30, (i) => ({ route: "/api/checkout", status: i < 12 ? 502 : 200 }));
    ids.forEach((parent, i) => fx.outbound(E() - 3 * MIN + i * 1000, "api.stripe.com", i < 12 ? { outcome: "timeout", parent } : { parent }));
    const found = fx.run(health);
    expect(signals(found)).toEqual(["dependency:api.stripe.com:critical"]);
    const [f] = found;
    expect(f!.summary).toBe("api.stripe.com is failing: 12 of 30 calls in 5 min ended in an error, timeout or 5xx, so /api/checkout fails.");
    expect(f!.evidence).toMatchObject({
      explains_routes: [{ route: "/api/checkout", failing_requests: 12, failures: 12 }],
      called_from: [{ route: "/api/checkout", calls: 30, failed: 12 }],
    });
  });

  it("a dependency answering 503 is failing too", () => {
    const ids = recent(15, { route: "/dependency-down", status: 502 });
    ids.forEach((parent, i) => fx.outbound(E() - 3 * MIN + i * 1000, "localhost", { status: 503, parent }));
    const found = fx.run(health).filter((f) => f.signal !== "too_little_traffic");
    expect(signals(found)).toEqual(["dependency:localhost:critical"]);
    expect(found[0]!.summary).toBe("localhost is failing: 15 of 15 calls in 5 min ended in an error, timeout or 5xx, so /dependency-down fails.");
  });

  it("a route failing for its own reasons is not blamed on a healthy dependency", () => {
    const ids = recent(30, (i) => ({ route: "/api/checkout", status: i < 12 ? 500 : 200 }));
    ids.forEach((parent, i) => fx.outbound(E() - 3 * MIN + i * 1000, "api.stripe.com", { parent }));
    expect(signals(fx.run(health))).toEqual(["server_errors:/api/checkout:critical"]);
  });

  it("unlinked calls (linkOutbound: false): both findings stay, the route names the likely dependency", () => {
    // What an app with linkOutbound: false sends: outbound events with no parent_id.
    recent(30, (i) => ({ route: "/api/checkout", status: i < 12 ? 502 : 200 }));
    for (let i = 0; i < 30; i++) fx.outbound(E() - 3 * MIN + i * 1000, "api.stripe.com", i < 12 ? { outcome: "timeout" } : {});
    const found = fx.run(health);
    // With no baseline a failing dependency alone is a warning (DECISIONS #50); nothing folds into it.
    expect(signals(found)).toEqual(["dependency:api.stripe.com:warning", "server_errors:/api/checkout:critical"]);
    const route = found.find((f) => f.signal === "server_errors")!;
    expect(route.cause).toBe("At the same time api.stripe.com failed 12 of 30 calls; likely related (calls are not linked on this Node version).");
    expect(route.evidence.likely_dependency).toMatchObject({ host: "api.stripe.com", linked: false });
    // Not folded: the dependency finding does not claim the route.
    expect(found.find((f) => f.signal === "dependency")!.evidence.explains_routes).toEqual([]);
  });

  it("a slow route names the slow upstream it calls (the AGENTS.md example)", () => {
    fx.baselineWeeks(E(), 4, (h) => {
      const ids = fx.requests(h, h + HOUR_MS, 40, (i) => ({ route: "/api/chat", duration: 4600 + i }));
      ids.forEach((parent, i) => fx.outbound(h + i * 60_000, "api.anthropic.com", { duration: 3900 + i, parent }));
    });
    const ids = recent(25, { route: "/api/chat", duration: 14_200 });
    ids.forEach((parent, i) => fx.outbound(E() - 4 * MIN + i * 5000, "api.anthropic.com", { duration: 12_800, parent }));
    const found = fx.run(health);
    expect(signals(found)).toEqual(["dependency:api.anthropic.com:critical", "latency:/api/chat:critical"]);
    const chat = found.find((f) => f.signal === "latency")!;
    expect(chat.summary).toBe("/api/chat p95 is 14.2 s, 3.1× its usual 4.6 s for Wednesday 14:00 UTC; 25 requests in 5 min.");
    expect(chat.cause).toBe("At the same time api.anthropic.com p95 rose from 3.9 s to 12.8 s: likely the upstream dependency.");
  });
});

describe("other signals", () => {
  it("traffic collapse while heartbeats arrive is critical; without heartbeats it is left to the Watchdog", () => {
    fx.baselineWeeks(E(), 4, (h) => fx.requests(h, h + HOUR_MS, 400, { route: "/" }));
    recent(3);
    expect(only("traffic_collapse")).toEqual([]);
    fx.heartbeats(fx.now - 5 * MIN, fx.now);
    expect(only("traffic_collapse")[0]).toMatchObject({ severity: "critical", evidence: { expected: 100, observed: 3 } });
  });

  it("a new error type is a warning; a known one at its usual rate is not", () => {
    recent(40);
    // History: TypeError /a seen two days ago.
    const h = Math.floor(E() / HOUR_MS) * HOUR_MS - 2 * 24 * HOUR_MS;
    fx.requests(h, h + HOUR_MS, 10);
    fx.error(h + 1000, "TypeError", "/a");
    fx.store.rollupHour(fx.appId, h);
    for (let i = 0; i < 4; i++) fx.error(E() - 2 * MIN + i, "RangeError", "/b");
    fx.error(E() - 2 * MIN, "TypeError", "/a");
    expect(signals(fx.run(health))).toEqual(["new_error:RangeError /b:warning"]);
    expect(only("new_error")[0]!.summary).toBe("New error: RangeError on /b, 4 times in 15 min, not seen in the last 7 days.");
  });

  it("a crash restart is a warning; a clean restart is not", () => {
    recent(40);
    fx.lifecycle(fx.now - 30 * MIN, "boot");
    fx.lifecycle(fx.now - 20 * MIN, "heartbeat");
    fx.lifecycle(fx.now - 10 * MIN, "boot");
    expect(signals(fx.run(health))).toEqual(["restart::warning"]);
    fx.lifecycle(fx.now - 5 * MIN, "shutdown");
    fx.lifecycle(fx.now - 4 * MIN, "boot");
    expect(only("restart")[0]!.evidence).toMatchObject({ boots_without_shutdown: [fx.now - 10 * MIN] });
  });

  it("a boot on a new release is a deploy (info, no warning)", () => {
    recent(40);
    fx.lifecycle(fx.now - 30 * MIN, "boot", "r1");
    fx.lifecycle(fx.now - 20 * MIN, "heartbeat", "r1");
    // No shutdown before it, but the release changed: a deploy, not a crash.
    fx.lifecycle(fx.now - 10 * MIN, "boot", "r2");
    const found = fx.run(health);
    expect(signals(found)).toEqual(["deploy:r2:info"]);
    expect(found[0]).toMatchObject({ fact: true, evidence: { release: "r2", previous_release: "r1" } });
    expect(found[0]!.summary).toMatch(/^app deployed release r2 \(was r1\) at \d\d:\d\d UTC\.$/);
  });

  it("a second boot on the same new release without a shutdown is a crash", () => {
    fx.requests(E() - 4 * MIN, E() - 1_000, 40, {}, "r2");
    fx.lifecycle(fx.now - 30 * MIN, "heartbeat", "r1");
    fx.lifecycle(fx.now - 12 * MIN, "boot", "r2");
    fx.lifecycle(fx.now - 8 * MIN, "heartbeat", "r2");
    fx.lifecycle(fx.now - 4 * MIN, "boot", "r2");
    expect(signals(fx.run(health))).toEqual(["deploy:r2:info", "restart::warning"]);
    expect(only("restart")[0]!.evidence).toMatchObject({ boots_without_shutdown: [fx.now - 4 * MIN] });
  });

  it("event-loop lag names the slowest routes in the same window", () => {
    recent(30, { route: "/report", duration: 900 });
    recent(30, { route: "/a", duration: 40 });
    for (let i = 0; i < 6; i++) fx.metric(E() - 4 * MIN + i * 30_000, "event_loop_lag_p99_ms", 650);
    const [f] = only("event_loop_lag");
    expect(f).toMatchObject({ severity: "critical", cause: "Likely synchronous work in /report." });
  });

  it("dropped events make the data incomplete (amber), never green", () => {
    recent(40);
    [0, 0, 12, 30].forEach((v, i) => fx.metric(E() - 10 * MIN + i * MIN, "sdk_dropped_events", v));
    expect(only("data_incomplete")[0]).toMatchObject({ severity: "warning", evidence: { sdk_dropped: 30 } });
  });

  it("a disabled app is not judged", () => {
    recent(40, { status: 500 });
    fx.store.disableApp("app", "test");
    expect(fx.run(health)).toEqual([]);
  });
});
