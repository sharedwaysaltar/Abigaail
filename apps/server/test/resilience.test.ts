// Resilience (agent 4, DECISIONS #111-#114): restarts paired per instance with
// their cause, a leak only as a rising post-GC floor, the route the SDK
// charged for blocking the event loop, and the cost of a cold start. Health
// folds its lag and memory findings into these, so nothing is reported twice.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { health, resilience } from "@abigaail/server";
import { HOUR_MS } from "@abigaail/store";
import { RESILIENCE as R } from "@abigaail/insights";
import type { LifecycleEvent } from "@abigaail/schema";
import { Fx, MIN, signals } from "./agentfx.js";

let fx: Fx;
beforeEach(() => {
  fx = new Fx();
});
afterEach(() => fx.close());

const E = () => fx.now - 45_000;
const only = (signal: string) => fx.run(resilience).filter((f) => f.signal === signal);
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";

/** Heartbeats every minute over [from, to), with an instance when given. */
const beats = (from: number, to: number, instance?: string) => {
  for (let t = from; t < to; t += MIN) fx.lifecycle(t, "heartbeat", "r1", instance ? { instance } : {});
};

describe("restarts", () => {
  it("a boot with no shutdown before it is a warning; a clean restart is not (old SDK, per app)", () => {
    fx.lifecycle(fx.now - 60 * MIN, "boot");
    beats(fx.now - 59 * MIN, fx.now - 30 * MIN);
    fx.lifecycle(fx.now - 30 * MIN, "shutdown");
    fx.lifecycle(fx.now - 29 * MIN, "boot");
    beats(fx.now - 28 * MIN, fx.now - 10 * MIN);
    expect(only("restart")).toEqual([]);
    fx.lifecycle(fx.now - 10 * MIN, "boot");
    const [f] = only("restart");
    expect(f).toMatchObject({ severity: "warning", evidence: { restarts_15_min: 1, loop: false } });
    expect(f!.summary).toBe("app restarted once in the last 15 min without a clean shutdown. Killed by a signal or the host (Node does not report which).");
  });

  it("3 in 15 min is a restart loop: the same finding turns critical", () => {
    fx.lifecycle(fx.now - 60 * MIN, "boot");
    beats(fx.now - 59 * MIN, fx.now - 12 * MIN);
    for (const t of [12, 8, 4]) {
      fx.lifecycle(fx.now - t * MIN, "boot");
      fx.lifecycle(fx.now - t * MIN + 30_000, "heartbeat");
    }
    const found = fx.run(resilience);
    expect(signals(found)).toEqual(["restart::critical"]);
    expect(found[0]!.summary).toMatch(/^app restarted 3 times in the last 15 min without a clean shutdown: a restart loop\. Each time: killed by a signal/);
  });

  it("5 in 2 h is a loop too, while one of them is recent", () => {
    fx.lifecycle(fx.now - 3 * HOUR_MS, "boot");
    beats(fx.now - 3 * HOUR_MS + MIN, fx.now - 100 * MIN);
    for (const t of [100, 80, 60, 40, 10]) {
      fx.lifecycle(fx.now - t * MIN, "boot");
      beats(fx.now - t * MIN + MIN, fx.now - (t - 5) * MIN);
    }
    expect(signals(fx.run(resilience))).toEqual(["restart::critical"]);
    // Once none is recent, it is over.
    fx.now += 10 * MIN;
    expect(only("restart")).toEqual([]);
  });

  it("a deploy (new release) and the app's first boot ever are never restarts", () => {
    fx.lifecycle(fx.now - 30 * MIN, "boot", "r1");
    beats(fx.now - 29 * MIN, fx.now - 10 * MIN);
    fx.lifecycle(fx.now - 10 * MIN, "boot", "r2");
    expect(only("restart")).toEqual([]);
  });

  it("two instances running side by side give no restart; a crash of one gives exactly one", () => {
    fx.start(fx.now - 90 * MIN, { instance: A });
    beats(fx.now - 89 * MIN, fx.now, A);
    // B starts while A runs: the old per-app rule would call this a crash.
    fx.start(fx.now - 60 * MIN + 30_000, { instance: B });
    beats(fx.now - 59 * MIN, fx.now - 12 * MIN, B);
    expect(only("restart")).toEqual([]);
    // B dies and comes back as itself.
    fx.start(fx.now - 10 * MIN, { instance: B });
    beats(fx.now - 9 * MIN, fx.now, B);
    const [f] = only("restart");
    expect(f).toMatchObject({ severity: "warning", evidence: { restarts_15_min: 1, crashes: [{ instance: B, replaced: false }] } });
  });

  it("a new instance that replaced one which went quiet without a shutdown is a crash; a scale-out is not", () => {
    fx.start(fx.now - 90 * MIN, { instance: A });
    beats(fx.now - 89 * MIN, fx.now - 10 * MIN, A);
    fx.start(fx.now - 9 * MIN, { instance: C });
    beats(fx.now - 8 * MIN, fx.now, C);
    expect(only("restart")[0]).toMatchObject({ evidence: { crashes: [{ instance: C, replaced: true }] } });
    expect(only("restart")[0]!.cause).toMatch(/a new instance took its place/);
  });

  it("a scale-out (the old instance keeps sending) is not a crash", () => {
    fx.start(fx.now - 90 * MIN, { instance: A });
    beats(fx.now - 89 * MIN, fx.now, A);
    fx.start(fx.now - 9 * MIN, { instance: C });
    beats(fx.now - 8 * MIN, fx.now, C);
    expect(only("restart")).toEqual([]);
  });

  it("waits for the ready event of an SDK that sends one before judging a boot", () => {
    fx.start(fx.now - 60 * MIN, { instance: A });
    beats(fx.now - 59 * MIN, fx.now - 2 * MIN, A);
    // B's boot arrived; its ready (with the instance) has not yet.
    fx.lifecycle(fx.now - 60_000, "boot");
    expect(only("restart")).toEqual([]);
  });

  it("an exit with code 0 in the crash record is a clean exit, not a crash", () => {
    fx.start(fx.now - 60 * MIN, { instance: A });
    beats(fx.now - 59 * MIN, fx.now - 10 * MIN, A);
    fx.start(fx.now - 9 * MIN, { instance: A, prev_exit: { code: 0, uptime_s: 3000 } });
    expect(only("restart")).toEqual([]);
  });
});

describe("restart causes, strongest evidence first", () => {
  const crashAt = (prev?: LifecycleEvent["prev_exit"]) => {
    fx.start(fx.now - 60 * MIN, { instance: A, heap_limit_mb: 4096, memory_limit_mb: 1024 });
    beats(fx.now - 59 * MIN, fx.now - 10 * MIN, A);
    fx.start(fx.now - 9 * MIN, { instance: A, heap_limit_mb: 4096, memory_limit_mb: 1024, ...(prev ? { prev_exit: prev } : {}) });
  };
  const cause = () => only("restart")[0]!;

  it("the crash record's uncaught error", () => {
    crashAt({ code: 1, error_type: "TypeError", frame: { file: "src/orders.ts", line: 42, fn: "placeOrder" } });
    expect(cause().summary).toContain("Uncaught TypeError at src/orders.ts:42 (exit code 1)");
    expect(cause().action).toMatch(/^Fix the uncaught error/);
  });

  it("the crash record's exit code", () => {
    crashAt({ code: 3 });
    expect(cause().summary).toContain("Exited with code 3");
  });

  it("an uncaught error event that got out just before the process went quiet", () => {
    fx.error(fx.now - 10 * MIN - 20_000, "RangeError", "/report", { file: "src/report.ts", line: 9 });
    crashAt();
    expect(cause().summary).toContain("Uncaught RangeError at src/report.ts:9");
  });

  it("an uncaught error long before is not the cause", () => {
    fx.error(fx.now - 30 * MIN, "RangeError", "/report");
    crashAt();
    expect(cause().summary).toContain("Killed by a signal or the host");
  });

  it("heap near its limit, projected to when the process went quiet: out of memory", () => {
    for (let i = 0; i < 6; i++) fx.metric(fx.now - 13 * MIN + i * 30_000, "memory_heap_used_mb", 3000 + i * 150);
    crashAt();
    expect(cause().summary).toMatch(/Likely out of memory \(heap \d+ of 4096 MB\)/);
    expect(cause().action).toMatch(/Find what keeps memory growing/);
  });

  it("no record, no error, but the heap rose steadily until it stopped: likely out of memory", () => {
    for (let i = 0; i < 5; i++) fx.metric(fx.now - 13 * MIN + i * 30_000, "memory_heap_used_mb", 20 + i * 18);
    crashAt();
    expect(cause().summary).toContain("Likely out of memory: its heap grew from 20 to 92 MB until it stopped");
  });

  it("a heap that rose and then levelled off before the crash is no evidence", () => {
    for (const [i, v] of [20, 50, 80, 80, 79].entries()) fx.metric(fx.now - 13 * MIN + i * 30_000, "memory_heap_used_mb", v);
    crashAt();
    expect(cause().summary).toContain("Killed by a signal or the host");
  });

  it("RSS near the container's memory limit", () => {
    for (let i = 0; i < 4; i++) fx.metric(fx.now - 12 * MIN + i * 30_000, "memory_rss_mb", 1000);
    crashAt();
    expect(cause().summary).toContain("Likely killed by the container memory limit (1000 of 1024 MB)");
  });

  it("without evidence: unknown, and says so", () => {
    for (let i = 0; i < 4; i++) fx.metric(fx.now - 12 * MIN + i * 30_000, "memory_heap_used_mb", 400);
    crashAt();
    expect(cause().summary).toContain("Killed by a signal or the host (Node does not report which)");
  });
});

describe("leaks: a rising post-GC floor", () => {
  /** Metrics every 5 min over [from, to): `floor(hours since from)`; the heap reading itself saws above it. */
  const series = (from: number, to: number, name: Parameters<Fx["metric"]>[1], floor: (h: number) => number) => {
    for (let t = from; t < to; t += 5 * MIN) fx.metric(t, name, floor((t - from) / HOUR_MS));
  };
  const boot = (at: number, o: Parameters<Fx["start"]>[1] = {}) => fx.start(at, { instance: A, ...o });

  it("rising for hours after the warm-up: a heap leak, with the slope", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", (h) => 120 + 25 * h + (h % 0.5 < 0.25 ? 3 : 0));
    const [f] = only("leak");
    expect(f).toMatchObject({ subject: "heap", severity: "warning" });
    expect(f!.summary).toMatch(/^app's heap floor after garbage collection rose from \d+ MB to \d+ MB over 4 h \d+ min since it started at \d\d:\d\d UTC \(\+2\d(\.\d)? MB\/h\)/);
  });

  it("high but flat memory is not a leak", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", () => 900);
    expect(only("leak")).toEqual([]);
  });

  it("a rise during the warm-up that then levels off is not a leak", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", (h) => (h < 0.5 ? 100 + 400 * h : 300 + (h % 1 < 0.5 ? 2 : -2)));
    expect(only("leak")).toEqual([]);
  });

  it("a jump at the end (a cache filled in the last half hour) is growth without a trend: not a leak", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", (h) => (h > 4.5 ? 260 : 200));
    expect(only("leak")).toEqual([]);
  });

  it("warm-up growth does not count: a slow drift after it is too small to be a leak", () => {
    boot(fx.now - 3 * HOUR_MS - 40 * MIN);
    series(fx.now - 3 * HOUR_MS - 40 * MIN, fx.now, "heap_floor_mb", (h) => (h < 0.5 ? 100 + 400 * h : 300 + 1.5 * h));
    expect(only("leak")).toEqual([]);
  });

  it("a sawtooth floor (a cache that fills and is cleared) is not a leak", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", (h) => 200 + 80 * (h % 1));
    expect(only("leak")).toEqual([]);
  });

  it("only the latest process counts: a restart resets the floor", () => {
    boot(fx.now - 6 * HOUR_MS);
    series(fx.now - 6 * HOUR_MS, fx.now - 2 * HOUR_MS, "heap_floor_mb", (h) => 120 + 40 * h);
    boot(fx.now - 2 * HOUR_MS);
    series(fx.now - 2 * HOUR_MS, fx.now, "heap_floor_mb", (h) => 120 + 40 * h);
    expect(only("leak")).toEqual([]);
  });

  it("RSS rising while the heap floor is flat: native memory", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", () => 150);
    series(fx.now - 5 * HOUR_MS, fx.now, "memory_rss_mb", (h) => 400 + 50 * h);
    expect(signals(fx.run(resilience))).toEqual(["leak:rss:warning"]);
  });

  it("RSS rising with the heap floor is the heap leak, reported once", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", (h) => 150 + 50 * h);
    series(fx.now - 5 * HOUR_MS, fx.now, "memory_rss_mb", (h) => 400 + 50 * h);
    expect(signals(fx.run(resilience))).toEqual(["leak:heap:warning"]);
  });

  it("external memory (Buffers) is its own leak", () => {
    boot(fx.now - 5 * HOUR_MS);
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", () => 150);
    series(fx.now - 5 * HOUR_MS, fx.now, "memory_external_mb", (h) => 20 + 30 * h);
    expect(signals(fx.run(resilience))).toEqual(["leak:external:warning"]);
  });

  it("critical when the trend reaches the heap limit within 6 h", () => {
    boot(fx.now - 5 * HOUR_MS, { heap_limit_mb: 400 });
    series(fx.now - 5 * HOUR_MS, fx.now, "heap_floor_mb", (h) => 120 + 40 * h);
    const [f] = only("leak");
    expect(f).toMatchObject({ severity: "critical", evidence: { limit_mb: 400 } });
    expect(f!.summary).toMatch(/reaches its 400 MB limit in about/);
  });

  it("an SDK without runtime signals (no heap floor) gets no leak finding at all", () => {
    fx.lifecycle(fx.now - 5 * HOUR_MS, "boot");
    series(fx.now - 5 * HOUR_MS, fx.now, "memory_rss_mb", (h) => 400 + 50 * h);
    expect(only("leak")).toEqual([]);
  });
});

describe("the route that blocks the event loop", () => {
  /** One SDK interval (30 s): blocks charged per route, and the distinct count. */
  const interval = (ts: number, all: number, charged: [string | undefined, number, number, number][]) => {
    fx.metric(ts, "event_loop_blocks", all);
    for (const [route, count, total, max] of charged) fx.block(ts, route, count, total, max);
  };

  it("names the route charged for most blocks", () => {
    for (let i = 0; i < 6; i++) interval(E() - 12 * MIN + i * MIN, 1, [["/report", 1, 300, 300]]);
    const found = fx.run(resilience);
    expect(signals(found)).toEqual(["loop_blocked:/report:warning"]);
    expect(found[0]!.summary).toBe(
      "/report blocked the event loop 6 times in 15 min (max 300 ms, 1.8 s in all): 100% of the blocks in app. Every other request waits while it runs.",
    );
  });

  it("critical: 3 or more in the last 5 min averaging 500 ms or more", () => {
    for (let i = 0; i < 6; i++) interval(E() - 4 * MIN + i * 30_000, 1, [["/export", 1, 800, 800]]);
    expect(signals(fx.run(resilience))).toEqual(["loop_blocked:/export:critical"]);
  });

  it("a route present in a minority of blocks is not named", () => {
    for (let i = 0; i < 20; i++) interval(E() - 12 * MIN + i * 30_000, 1, i < 6 ? [["/a", 1, 300, 300], [undefined, 1, 0, 300]] : [[undefined, 1, 300, 300]]);
    expect(only("loop_blocked")).toEqual([]);
  });

  it("needs at least 5 blocks", () => {
    for (let i = 0; i < 4; i++) interval(E() - 12 * MIN + i * MIN, 1, [["/report", 1, 900, 900]]);
    expect(only("loop_blocked")).toEqual([]);
    interval(E() - 30_000, 1, [["/report", 1, 900, 900]]);
    expect(only("loop_blocked").map((f) => f.subject)).toEqual(["/report"]);
  });

  it("needs a second of blocked time", () => {
    for (let i = 0; i < 6; i++) interval(E() - 6 * MIN + i * 30_000, 1, [["/tiny", 1, 120, 120]]);
    expect(only("loop_blocked")).toEqual([]);
  });

  it("Health folds its lag finding into it, and keeps it when no route is named", () => {
    fx.requests(E() - 4 * MIN, E() - 1_000, 30, { route: "/report", duration: 900 });
    for (let i = 0; i < 6; i++) fx.metric(E() - 4 * MIN + i * 30_000, "event_loop_lag_p99_ms", 650);
    expect(fx.run(health).filter((f) => f.signal === "event_loop_lag")).toHaveLength(1);
    for (let i = 0; i < 6; i++) interval(E() - 12 * MIN + i * MIN, 1, [["/report", 1, 400, 400]]);
    expect(fx.run(health).filter((f) => f.signal === "event_loop_lag")).toEqual([]);
    expect(signals(fx.run(resilience))).toEqual(["loop_blocked:/report:warning"]);
  });
});

describe("profiles name the function (#120)", () => {
  const RENDER = { file: "src/docs.ts", line: 88, fn: "renderDocs" };
  const HANDLER = { file: "src/server.ts", line: 12, fn: "handle" };
  const interval = (ts: number, route: string) => {
    fx.metric(ts, "event_loop_blocks", 1);
    fx.block(ts, route, 1, 400, 400);
  };

  it("loop_blocked names the function the samples inside the blocks ran in", () => {
    for (let i = 0; i < 6; i++) interval(E() - 12 * MIN + i * MIN, "/docs");
    fx.profile(E() - 2 * MIN, "block", [{ frames: [HANDLER, RENDER], weight: 71 }, { frames: [HANDLER], weight: 29 }]);
    const [f] = only("loop_blocked");
    expect(f!.summary).toContain("Mostly in renderDocs (src/docs.ts:88), 71% of the samples taken while the loop was blocked.");
    expect(f!.cause).toBe("Synchronous work in renderDocs (src/docs.ts:88), called from /docs.");
  });

  it("time inside Node's or V8's own code (a regex, a string method) counts for the project function that called it", () => {
    for (let i = 0; i < 6; i++) interval(E() - 12 * MIN + i * MIN, "/docs");
    const NATIVE = { file: "(native)", line: 0, fn: "replace" };
    fx.profile(E() - 2 * MIN, "block", [{ frames: [HANDLER, RENDER, NATIVE], weight: 60 }, { frames: [HANDLER, RENDER], weight: 15 }, { frames: [HANDLER], weight: 25 }]);
    expect(only("loop_blocked")[0]!.summary).toContain("Mostly in renderDocs (src/docs.ts:88), 75% of the samples taken while the loop was blocked.");
  });

  it("with two routes blocking, the samples cannot be told apart: no function is named", () => {
    // Both in flight through every block, so each is charged for all of them.
    for (let i = 0; i < 6; i++) {
      const ts = E() - 12 * MIN + i * MIN;
      fx.metric(ts, "event_loop_blocks", 1);
      fx.block(ts, "/docs", 1, 200, 400);
      fx.block(ts, "/export", 1, 200, 400);
    }
    fx.profile(E() - 2 * MIN, "block", [{ frames: [HANDLER, RENDER], weight: 71 }]);
    const found = only("loop_blocked");
    expect(found.map((f) => f.subject).sort()).toEqual(["/docs", "/export"]);
    for (const f of found) expect(f.summary).not.toContain("Mostly in");
  });

  it("a heap leak names the site whose retained memory grew", () => {
    fx.start(fx.now - 5 * HOUR_MS, { instance: A });
    for (let t = fx.now - 5 * HOUR_MS; t < fx.now; t += 5 * MIN) fx.metric(t, "heap_floor_mb", 120 + 25 * ((t - (fx.now - 5 * HOUR_MS)) / HOUR_MS));
    const SITE = { file: "src/search.ts", line: 42, fn: "rememberSearch" };
    fx.profile(fx.now - 4 * HOUR_MS, "heap", [{ frames: [HANDLER, SITE], weight: 5 * 1048576 }, { frames: [HANDLER], weight: 8 * 1048576 }]);
    fx.profile(fx.now - 10 * MIN, "heap", [{ frames: [HANDLER, SITE], weight: 105 * 1048576 }, { frames: [HANDLER], weight: 9 * 1048576 }]);
    const [f] = only("leak");
    expect(f!.summary).toContain("Retained memory grew most at rememberSearch (src/search.ts:42): +100 MB of sampled heap since the start.");
    expect(f!.action).toContain("rememberSearch");
  });

  it("a leak never names the SDK's own code; the app's growing site is named", () => {
    fx.start(fx.now - 5 * HOUR_MS, { instance: A });
    for (let t = fx.now - 5 * HOUR_MS; t < fx.now; t += 5 * MIN) fx.metric(t, "heap_floor_mb", 120 + 25 * ((t - (fx.now - 5 * HOUR_MS)) / HOUR_MS));
    const SDK = { file: "(abigaail)", line: 0 };
    const SITE = { file: "src/cache.ts", line: 7, fn: "remember" };
    fx.profile(fx.now - 4 * HOUR_MS, "heap", [{ frames: [SDK], weight: 1 * 1048576 }, { frames: [HANDLER, SITE], weight: 1 * 1048576 }]);
    fx.profile(fx.now - 10 * MIN, "heap", [{ frames: [SDK], weight: 90 * 1048576 }, { frames: [HANDLER, SITE], weight: 21 * 1048576 }]);
    const [f] = only("leak");
    expect(f!.summary).toContain("Retained memory grew most at remember (src/cache.ts:7): +20 MB");
    expect(f!.summary).not.toContain("abigaail");
  });

  it("an out-of-memory restart names where the dead process's heap went", () => {
    fx.start(fx.now - 13 * MIN, { instance: A });
    for (let i = 0; i < 5; i++) fx.metric(fx.now - 12 * MIN + i * 30_000, "memory_heap_used_mb", 20 + i * 18);
    fx.profile(fx.now - 10 * MIN - 30_000, "heap", [{ frames: [HANDLER, { file: "src/search.ts", line: 42, fn: "rememberSearch" }], weight: 60 * 1048576 }, { frames: [HANDLER], weight: 10 * 1048576 }]);
    beats(fx.now - 12 * MIN, fx.now - 10 * MIN, A);
    fx.start(fx.now - 9 * MIN, { instance: A });
    expect(only("restart")[0]!.summary).toContain("until it stopped; most of its sampled heap was allocated in rememberSearch (src/search.ts:42)");
  });
});

describe("Health folds the slowness of a blocking route into it", () => {
  it("folds already when the first blocks are as long as the route's p95, before Resilience has its 5 blocks", () => {
    // Without a baseline, 2 s is the latency floor.
    fx.requests(E() - 4 * MIN, E() - 1_000, 30, { route: "/report", duration: 2_500 });
    const latency = () => fx.run(health).filter((f) => f.signal === "latency").map((f) => f.subject);
    expect(latency()).toEqual(["/report"]);
    fx.block(E() - 60_000, "/report", 2, 4_800, 2_400);
    expect(latency()).toEqual([]);
    expect(only("loop_blocked")).toEqual([]);
  });

  it("an app sending runtime signals is judged only up to its latest runtime interval; one without is judged as before (#125)", () => {
    // Slow /report requests only in the last 30 s of the window.
    fx.requests(E() - 30_000, E() - 1_000, 30, { route: "/report", duration: 2_500 });
    const latency = () => fx.run(health).filter((f) => f.signal === "latency").map((f) => f.subject);
    expect(latency()).toEqual(["/report"]);
    // Its latest runtime interval ended 40 s before the window's end: those requests wait for the next one.
    fx.metric(E() - 40_000, "event_loop_blocks", 0);
    expect(latency()).toEqual([]);
  });

  it("short blocks do not explain a much higher p95", () => {
    fx.requests(E() - 4 * MIN, E() - 1_000, 30, { route: "/report", duration: 2_000 });
    fx.block(E() - 60_000, "/report", 2, 240, 120);
    expect(fx.run(health).filter((f) => f.signal === "latency").map((f) => f.subject)).toEqual(["/report"]);
  });

  it("no latency finding for the route that blocks; other slow routes keep theirs", () => {
    const interval = (ts: number) => {
      fx.metric(ts, "event_loop_blocks", 1);
      fx.block(ts, "/report", 1, 400, 400);
    };
    fx.requests(E() - 4 * MIN, E() - 1_000, 30, { route: "/report", duration: 2_500 });
    fx.requests(E() - 4 * MIN, E() - 1_000, 30, { route: "/slow", duration: 2_500 });
    const latency = () => fx.run(health).filter((f) => f.signal === "latency").map((f) => f.subject);
    expect(latency().sort()).toEqual(["/report", "/slow"]);
    for (let i = 0; i < 6; i++) interval(E() - 12 * MIN + i * MIN);
    expect(latency()).toEqual(["/slow"]);
  });
});

describe("cold start", () => {
  const starts = (ms: number[], release = "r1") => {
    ms.forEach((startup_ms, i) => {
      const at = fx.now - (ms.length - i) * 6 * HOUR_MS;
      fx.start(at, { instance: A, startup_ms, release });
      fx.lifecycle(at + MIN, "shutdown", release, { instance: A });
    });
  };

  it("a start far slower than the app's usual is a warning, per release, as a fact", () => {
    starts([1000, 1100, 900, 1050, 1000]);
    fx.start(fx.now - 20 * MIN, { instance: A, startup_ms: 6500, release: "r2" });
    const [f] = only("cold_start");
    expect(f).toMatchObject({ subject: "r2", severity: "warning", fact: true });
    expect(f!.summary).toMatch(/^app \(release r2\) took 6\.5 s to start, 6\.\d× its usual 1\.0 s after starting at/);
  });

  it("a start within the usual spread, or one under 2 s, is not", () => {
    starts([1000, 1100, 900, 1050, 1000]);
    fx.start(fx.now - 20 * MIN, { instance: A, startup_ms: 1900 });
    expect(only("cold_start")).toEqual([]);
  });

  it("without earlier starts, only a very slow one (30 s) is reported", () => {
    fx.start(fx.now - 20 * MIN, { instance: A, startup_ms: 12_000 });
    expect(only("cold_start")).toEqual([]);
    fx.start(fx.now - 10 * MIN, { instance: A, startup_ms: 41_000 });
    expect(only("cold_start")[0]!.summary).toMatch(/took 41\.0 s to start after starting/);
  });

  it("is no longer reported an hour after the start", () => {
    fx.start(fx.now - R.coldShowMs - 5 * MIN, { instance: A, startup_ms: 41_000 });
    expect(only("cold_start")).toEqual([]);
  });

  it("the first requests after a start, far slower than usual, are reported too", () => {
    const boot = fx.now - 20 * MIN;
    fx.baselineWeeks(boot, 3, (h) => fx.requests(h, h + HOUR_MS, 200, { duration: 50 }));
    fx.start(boot, { instance: A, startup_ms: 900 });
    fx.requests(boot + 5_000, boot + R.coldWindowMs - 1_000, 40, { duration: 400 });
    const [f] = only("cold_start");
    expect(f!.summary).toMatch(/answered its first 40 requests with p95 400 ms, 8\.0× its usual 50 ms/);
  });
});
