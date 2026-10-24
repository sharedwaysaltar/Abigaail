// Owner's decision on the profiler's start pause (DECISIONS #121): with
// profiling on and no blocking code at all, the pauses the profiler itself
// causes when it starts a CPU window must not become a block, a lag reading,
// a loop_blocked finding or an event_loop_lag finding; they are reported as
// profiler_pause_ms. The pause here is simulated: the fake inspector holds the
// main thread for 250 ms on Profiler.start, as V8 does while it records code.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { health, resilience } from "@abigaail/server";
import { init, type AbigaailNode, type InspectorModule } from "@abigaail/node";
import type { AbigaailEvent, Batch } from "@abigaail/schema";
import { validateBatch } from "@abigaail/schema/validate";
import { Fx, MIN } from "./agentfx.js";

const PAUSE_MS = 250;
const hold = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

const pausingInspector = {
  Session: class {
    connect() {}
    post(method: string, _p: unknown, cb: (err: Error | null, result?: unknown) => void) {
      if (method === "Profiler.start") hold(PAUSE_MS);
      if (method === "Profiler.stop") return cb(null, { profile: { nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } }], startTime: 0, samples: [], timeDeltas: [] } });
      if (method === "HeapProfiler.getSamplingProfile") return cb(null, { profile: { head: { callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, selfSize: 0, children: [] } } });
      cb(null, {});
    }
    disconnect() {}
  },
} as unknown as InspectorModule;

let fx: Fx;
let adapter: AbigaailNode | undefined;
beforeEach(() => {
  fx = new Fx();
});
afterEach(async () => {
  await adapter?.shutdown(100);
  adapter = undefined;
  fx.close();
});

describe("the profiler's own start pause is not the app blocking its loop", () => {
  it("profiling on, no blocking code: no block, no lag, no loop_blocked or event_loop_lag finding; the pause is reported apart", async () => {
    const batches: Batch[] = [];
    adapter = init({
      endpoint: "http://127.0.0.1:9/ingest", ingestKey: "abk_test", release: "r1", environment: "test",
      flushIntervalMs: 0, metricsIntervalMs: 300, heartbeatIntervalMs: 0, env: {}, nodeVersion: "24.0.0", onInternalError: () => {},
      transport: async (b) => {
        batches.push(structuredClone(b));
        return { result: "ok", features: ["runtime_v1", "profile_v1"] };
      },
      profiling: true,
      inspector: pausingInspector,
      // A window every ~0.45 s, so nearly every metrics interval holds a pause.
      profilerTiming: { windowMs: 50, everyMs: 200, idleRetryMs: 10, startBudgetMs: 1_000 },
    });
    await adapter.flush();
    await new Promise((r) => setTimeout(r, 3_000));
    await adapter.flush();
    for (const b of batches) expect(validateBatch(b)).toMatchObject({ ok: true });
    const events = batches.flatMap((b) => b.events);
    const metrics = (name: string) => events.flatMap((e) => (e.type === "metric" && e.name === name ? [e.value] : []));

    // Not vacuous: the profiler really paused the app, several times.
    expect(metrics("profiler_pause_ms").reduce((a, b) => a + b, 0)).toBeGreaterThan(3 * PAUSE_MS);
    expect(events.filter((e) => e.type === "block")).toEqual([]);
    // An interval sampled while the histogram still held a pause reports no lag; none reports the pause.
    for (const lag of metrics("event_loop_lag_p99_ms")) expect(lag).toBeLessThan(100);

    // What the agents make of it, stored as ingest would, in the last few minutes.
    const first = Math.min(...events.map((e) => e.client_ts));
    const at = (e: AbigaailEvent) => fx.now - 4 * MIN + (e.client_ts - first);
    fx.store.insertBatch(fx.appId, { receivedAt: fx.now, release: "r1", environment: "test", events: events.map((e) => ({ event: e, derived: { ts: at(e) } })) });
    // Requests that matter, so Health judges the app.
    fx.requests(fx.now - 4 * MIN, fx.now - 50_000, 40);
    const signals = [...fx.run(health), ...fx.run(resilience)].map((f) => f.signal);
    expect(signals).not.toContain("event_loop_lag");
    expect(signals).not.toContain("loop_blocked");
  }, 15_000);
});
