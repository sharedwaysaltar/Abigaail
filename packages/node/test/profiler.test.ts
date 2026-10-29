// Continuous profiling (DECISIONS #118-#121): opt-in with a kill switch, real
// inspector profiles that name functions and project-relative lines and
// nothing else, samples charged to a route only when unambiguous, a block
// profile from the runtime monitor's blocks, bounded payloads, a work budget
// with back-off, and fail-open on every inspector error.

import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AbigaailClient } from "@abigaail/core";
import { init, isSdkUrl, PROFILER_STATE, Profiler, profileFrame, profilingWanted, RuntimeMonitor, RUNTIME, type AbigaailNode, type InspectorModule } from "@abigaail/node";
import type { Batch, ProfileEvent } from "@abigaail/schema";
import { validateBatch } from "@abigaail/schema/validate";
import { leaks, pii, rng } from "../../schema/test/pii.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const busy = (ms: number) => {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) x += Math.sqrt(x + 1);
  return x;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Named so the profile can be checked for them.
function hotLoopForTest(ms: number) {
  return busy(ms);
}
const retained: unknown[] = [];
function retainForTest(mb: number) {
  for (let i = 0; i < mb * 16; i++) retained.push(new Array(8192).fill(i));
}

const stopping: { stop(): void }[] = [];
let adapter: AbigaailNode | undefined;
afterEach(async () => {
  for (const s of stopping.splice(0)) s.stop();
  await adapter?.shutdown(100);
  adapter = undefined;
  retained.length = 0;
});

function fakeClient(features: string[] = ["runtime_v1", "profile_v1"], breaker: "closed" | "open" = "closed") {
  const events: Record<string, unknown>[] = [];
  const client: AbigaailClient = {
    capture: (e) => void events.push(e as Record<string, unknown>),
    hold: () => {},
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    stats: () => ({ queued: 0, dropped: 0, invalid: 0, sampledOut: 0, sent: 0, rejected: 0, failedSends: 0, unsupported: 0, breaker }),
    features: () => new Set(features),
  };
  return { client, events };
}

function setup(o: { inspector?: InspectorModule; now?: () => number; features?: string[]; breaker?: "closed" | "open"; timing?: { idleRetryMs?: number; idleWaitMs?: number } } = {}) {
  const { client, events } = fakeClient(o.features, o.breaker);
  const warnings: string[] = [];
  const runtime = new RuntimeMonitor(client, () => {}, { instanceKey: "abk_test", env: {}, peekRoute: (p) => p }, () => {});
  const profiler = new Profiler(client, runtime, () => {}, (w) => warnings.push(w), { root: ROOT, manual: true, inspector: o.inspector, now: o.now, timing: o.timing });
  stopping.push(runtime, profiler);
  const profiles = () => events.filter((e) => e.type === "profile") as unknown as ProfileEvent[];
  const asBatch = (): Batch => ({ schema_version: 1, sdk: { name: "@abigaail/core", version: "0.1.0" }, release: "r1", environment: "test", events: events.map((e, i) => ({ event_id: `6f1c1d1e-2b2a-4c3d-8e4f-${String(i).padStart(12, "0")}`, client_ts: 1, ...e })) as Batch["events"] });
  return { runtime, profiler, events, profiles, warnings, asBatch };
}

const fnsOf = (p: ProfileEvent) => new Set(p.frames.map((f) => f.fn).filter(Boolean));

describe("opt-in, with a kill switch", () => {
  it("off unless asked; ABIGAAIL_PROFILING=off beats the option", () => {
    expect(profilingWanted(undefined, {})).toBe(false);
    expect(profilingWanted(undefined, { ABIGAAIL_PROFILING: "1" })).toBe(true);
    expect(profilingWanted(true, {})).toBe(true);
    expect(profilingWanted(true, { ABIGAAIL_PROFILING: "off" })).toBe(false);
    expect(profilingWanted(true, { ABIGAAIL_PROFILING: "0" })).toBe(false);
  });

  it("with the kill switch set, init never opens an inspector session", async () => {
    let sessions = 0;
    const inspector = { Session: class { constructor() { sessions++; } connect() {} post() {} disconnect() {} } } as unknown as InspectorModule;
    adapter = init({ endpoint: "http://127.0.0.1:9/ingest", ingestKey: "k", release: "r1", environment: "test", flushIntervalMs: 0, metricsIntervalMs: 0, heartbeatIntervalMs: 0, transport: async () => "ok", onInternalError: () => {}, env: { ABIGAAIL_PROFILING: "off" }, nodeVersion: "24.0.0", profiling: true, inspector });
    await sleep(20);
    expect(sessions).toBe(0);
  });
});

describe("real profiles from node:inspector", () => {
  it("name the hot function with its project-relative file and line; a route only when it ran alone; blocks too", async () => {
    const s = setup();
    await s.profiler.start();
    expect(s.profiler.current).toBe(PROFILER_STATE.on);
    const res = { headersSent: false, destroyed: false, writableFinished: false } as unknown as http.ServerResponse;
    const window = s.profiler.cpuWindow(1500);
    await sleep(50);
    s.runtime.requestStart(res, "/report");
    hotLoopForTest(700);
    s.runtime.requestFinish(res, "/report");
    await window;
    s.profiler.send();
    const all = s.profiles();
    const app = all.find((p) => p.kind === "cpu" && !p.route)!;
    const route = all.find((p) => p.kind === "cpu" && p.route === "/report")!;
    const block = all.find((p) => p.kind === "block")!;
    for (const p of [app, route, block]) {
      expect(p).toBeDefined();
      expect(fnsOf(p)).toContain("hotLoopForTest");
    }
    const frame = app.frames.find((f) => f.fn === "hotLoopForTest")!;
    expect(frame.file).toBe("packages/node/test/profiler.test.ts");
    expect(frame.line).toBeGreaterThan(20);
    expect(app.samples_concurrent).toBe(0);
    expect(route.samples).toBeGreaterThan(40);
    expect(validateBatch(s.asBatch())).toMatchObject({ ok: true });
  }, 15_000);

  it("samples taken while several requests were in flight belong to no route (concurrent)", async () => {
    const s = setup();
    await s.profiler.start();
    const res = () => ({ headersSent: false, destroyed: false, writableFinished: false }) as unknown as http.ServerResponse;
    const a = res();
    const b = res();
    const window = s.profiler.cpuWindow(1200);
    await sleep(50);
    s.runtime.requestStart(a, "/report");
    s.runtime.requestStart(b, "/export");
    hotLoopForTest(700);
    s.runtime.requestFinish(a, "/report");
    s.runtime.requestFinish(b, "/export");
    await window;
    s.profiler.send();
    const all = s.profiles();
    expect(all.filter((p) => p.route)).toEqual([]);
    expect(all.find((p) => p.kind === "cpu" && !p.route)!.samples_concurrent).toBeGreaterThan(40);
  }, 15_000);

  it("the heap profile names the site that keeps memory", async () => {
    const s = setup();
    await s.profiler.start();
    retainForTest(24);
    await s.profiler.heapProfile();
    const heap = s.profiles().find((p) => p.kind === "heap")!;
    const top = [...heap.stacks].sort((a, b) => b.weight - a.weight)[0]!;
    expect(heap.frames[top.frames.at(-1)!]).toMatchObject({ fn: "retainForTest", file: "packages/node/test/profiler.test.ts" });
    expect(top.weight).toBeGreaterThan(10 * 1048576);
    expect(validateBatch(s.asBatch())).toMatchObject({ ok: true });
  }, 15_000);

  it("sends nothing before the server announced profile_v1", async () => {
    const s = setup({ features: ["runtime_v1"] });
    await s.profiler.start();
    await s.profiler.cpuWindow(200);
    s.profiler.send();
    await s.profiler.heapProfile();
    expect(s.profiles()).toEqual([]);
  }, 15_000);
});

describe("no personal data in a profile", () => {
  it("planted in closures, maps, strings on the heap, function names, file paths and eval'd source: none of it is sent", async () => {
    const r = rng(118);
    const planted = Array.from({ length: 30 }, () => pii(r));
    // A module loaded from outside the project, from a directory named after a person.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${planted[0]!.text.replace(/[^A-Za-z0-9]/g, "_").slice(0, 40)}-`));
    const file = path.join(dir, "jane_doe_profile.mjs");
    fs.writeFileSync(file, `export function spinFor(ms) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += 1; return x; }`);
    try {
      const outside = (await import(pathToFileURL(file).href)) as { spinFor: (ms: number) => number };
      const users = new Map(planted.map((p, i) => [p.text, { email: p.text, id: i }]));
      const closures = planted.map((p) => () => p.text.length);
      // A method whose name, in the source, is personal data: not an identifier, so never sent.
      const named = new Function(`return { ${JSON.stringify(planted[1]!.text)}() { const end = performance.now() + 150; let x = 0; while (performance.now() < end) x++; return x; } };`)()[planted[1]!.text] as () => number;
      // eval'd code with personal data in its source.
      const evaled = new Function(`const secret = ${JSON.stringify(planted[2]!.text)}; const end = performance.now() + 150; let x = 0; while (performance.now() < end) x += secret.length; return x;`);
      const s = setup();
      await s.profiler.start();
      const window = s.profiler.cpuWindow(1200);
      await sleep(30);
      outside.spinFor(200);
      named();
      evaled();
      hotLoopForTest(200);
      await window;
      s.profiler.send();
      retainForTest(4);
      await s.profiler.heapProfile();
      expect(users.size + closures.length).toBeGreaterThan(0);

      const sent = JSON.stringify(s.events);
      expect(s.profiles().length).toBeGreaterThanOrEqual(2);
      expect(sent).toContain("hotLoopForTest");
      expect(validateBatch(s.asBatch())).toMatchObject({ ok: true });
      const found = planted.flatMap((p) => leaks(sent, p).map((n) => `${p.kind}: ${n}`));
      expect([...new Set(found)]).toEqual([]);
      expect(sent).not.toMatch(/\/home\/|\/Users\/|\/tmp\/|jane_doe|secret/);
      // The outside module is "(external)", the eval'd code "(native)": placeholders, no path.
      const files = new Set(s.profiles().flatMap((p) => p.frames.map((f) => f.file)));
      expect([...files].every((f) => f.startsWith("(") || !path.isAbsolute(f))).toBe(true);
      expect(files).toContain("(external)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// ---- a fake inspector, for the failure paths ---------------------------------

function fakeInspector(o: { failOn?: string; throwOnConnect?: boolean; profile?: unknown } = {}) {
  const calls: string[] = [];
  let disconnected = 0;
  const inspector = {
    Session: class {
      connect() {
        if (o.throwOnConnect) throw new Error("Another session is already attached");
      }
      post(method: string, _params: unknown, cb: (err: Error | null, result?: unknown) => void) {
        calls.push(method);
        if (method === o.failOn) return cb(new Error("inspector says no"));
        if (method === "Profiler.stop") return cb(null, { profile: o.profile ?? { nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } }], startTime: 0, samples: [], timeDeltas: [] } });
        if (method === "HeapProfiler.getSamplingProfile") return cb(null, { profile: { head: { callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, selfSize: 0, children: [] } } });
        cb(null, {});
      }
      disconnect() {
        disconnected++;
      }
    },
  } as unknown as InspectorModule;
  return { inspector, calls, disconnected: () => disconnected };
}

describe("fail-open", () => {
  it("a session that cannot attach turns profiling off with one warning, never the SDK", async () => {
    const s = setup({ inspector: fakeInspector({ throwOnConnect: true }).inspector });
    await s.profiler.start();
    expect(s.profiler.current).toBe(PROFILER_STATE.disabled);
    expect(s.warnings).toEqual(["profiling could not start (another profiler or debugger attached?); it is off"]);
    expect(await s.profiler.cpuWindow(10)).toBe(false);
  });

  it("an error on any protocol call turns profiling off", async () => {
    const f = fakeInspector({ failOn: "Profiler.start" });
    const s = setup({ inspector: f.inspector });
    await s.profiler.start();
    await expect(s.profiler.cpuWindow(10)).rejects.toThrow();
    // The scheduler's guard turns that into "off"; through init it never reaches the app.
    adapter = init({ endpoint: "http://127.0.0.1:9/ingest", ingestKey: "k", release: "r1", environment: "test", flushIntervalMs: 0, metricsIntervalMs: 0, heartbeatIntervalMs: 0, transport: async () => ({ result: "ok", features: ["runtime_v1", "profile_v1"] }), onInternalError: () => {}, env: {}, nodeVersion: "24.0.0", profiling: true, inspector: fakeInspector({ failOn: "Profiler.enable" }).inspector });
    await sleep(20);
    adapter.captureError(new Error("still works"));
    expect(adapter.stats().invalid).toBe(0);
  });

  it("shutdown disconnects the session", async () => {
    const f = fakeInspector();
    adapter = init({ endpoint: "http://127.0.0.1:9/ingest", ingestKey: "k", release: "r1", environment: "test", flushIntervalMs: 0, metricsIntervalMs: 0, heartbeatIntervalMs: 0, transport: async () => "ok", onInternalError: () => {}, env: {}, nodeVersion: "24.0.0", profiling: true, inspector: f.inspector });
    await sleep(20);
    expect(f.calls).toContain("HeapProfiler.startSampling");
    await adapter.shutdown(100);
    adapter = undefined;
    expect(f.disconnected()).toBe(1);
  });
});

describe("overhead budget and back-off", () => {
  it("over budget: backs off, and after 3 overruns is off for the process with one warning", async () => {
    let t = 0;
    // Every reading of the work clock is 25 ms later: reading each window costs more than its 20 ms budget.
    const s = setup({ inspector: fakeInspector().inspector, now: () => (t += 25) });
    await s.profiler.start();
    expect(await s.profiler.cpuWindow(5)).toBe(true);
    expect(s.profiler.current).toBe(PROFILER_STATE.backingOff);
    await s.profiler.cpuWindow(5);
    await s.profiler.cpuWindow(5);
    expect(s.profiler.current).toBe(PROFILER_STATE.disabled);
    expect(await s.profiler.cpuWindow(5)).toBe(false);
    expect(s.warnings).toEqual(["profiling went over its budget (60 ms to start a window, 20 ms to read it) 3 times; it is off for this process"]);
  });

  it("a slow start (V8 recording a large app's code) counts as an overrun too", async () => {
    let t = 0;
    let calls = -1;
    const f = fakeInspector();
    // A window reads the clock 6 times: the idle wait, its start time, before and after the start,
    // before and after reading it. Only the start is slow (70 ms); reading takes 1 ms.
    const s = setup({ inspector: f.inspector, now: () => (calls < 0 ? t : (t += ++calls % 6 === 4 ? 70 : 1)) });
    await s.profiler.start();
    calls = 0;
    await s.profiler.cpuWindow(5);
    expect(s.profiler.current).toBe(PROFILER_STATE.backingOff);
  });

  it("skips windows while the app is loaded or ingest is unreachable", async () => {
    const f = fakeInspector();
    const s = setup({ inspector: f.inspector });
    await s.profiler.start();
    s.profiler.setLoad(250, 10);
    expect(await s.profiler.cpuWindow(5)).toBe(false);
    s.profiler.setLoad(5, 95);
    expect(await s.profiler.cpuWindow(5)).toBe(false);
    expect(s.profiler.current).toBe(PROFILER_STATE.backingOff);
    expect(f.calls).not.toContain("Profiler.start");
    const open = setup({ inspector: fakeInspector().inspector, breaker: "open" });
    await open.profiler.start();
    expect(await open.profiler.cpuWindow(5)).toBe(false);
  });
});

describe("a window starts only when no request is in flight (owner's decision, #121)", () => {
  const res = () => ({ headersSent: false, destroyed: false, writableFinished: false }) as unknown as http.ServerResponse;

  it("waits for the requests in flight to finish, then starts", async () => {
    const f = fakeInspector();
    const s = setup({ inspector: f.inspector, timing: { idleRetryMs: 10, idleWaitMs: 2_000 } });
    await s.profiler.start();
    const r = res();
    s.runtime.requestStart(r, "/report");
    const window = s.profiler.cpuWindow(5);
    await sleep(60);
    expect(f.calls).not.toContain("Profiler.start");
    s.runtime.requestFinish(r, "/report");
    expect(await window).toBe(true);
    expect(f.calls).toContain("Profiler.start");
  });

  it("skips the window when the app is never idle within the wait", async () => {
    const f = fakeInspector();
    const s = setup({ inspector: f.inspector, timing: { idleRetryMs: 10, idleWaitMs: 80 } });
    await s.profiler.start();
    s.runtime.requestStart(res(), "/busy");
    expect(await s.profiler.cpuWindow(5)).toBe(false);
    expect(f.calls).not.toContain("Profiler.start");
    // Not an overrun or a back-off: the next window simply tries again.
    expect(s.profiler.current).toBe(PROFILER_STATE.on);
  });

  it("a long-open stream (SSE) does not keep it from ever starting", async () => {
    const f = fakeInspector();
    let t = 0;
    const { client } = fakeClient();
    const runtime = new RuntimeMonitor(client, () => {}, { instanceKey: "abk_test", env: {}, peekRoute: (p) => p, now: () => t, manualTick: true }, () => {});
    const profiler = new Profiler(client, runtime, () => {}, () => {}, { root: ROOT, manual: true, inspector: f.inspector, timing: { idleRetryMs: 10, idleWaitMs: 80 } });
    stopping.push(runtime, profiler);
    await profiler.start();
    runtime.requestStart(({ headersSent: true, destroyed: false, writableFinished: false }) as unknown as http.ServerResponse, "/events");
    t = 10_000;
    expect(await profiler.cpuWindow(5)).toBe(true);
  });
});

describe("a CPU window after a block (owner's fix after the 10b test)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A runtime monitor and a profiler on one fake clock; the fake inspector counts window starts. */
  function blockSetup() {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const f = fakeInspector();
    const { client } = fakeClient();
    const runtime = new RuntimeMonitor(client, () => {}, { instanceKey: "abk_test", env: {}, peekRoute: (p) => p, now: () => clock, manualTick: true }, () => {});
    const profiler = new Profiler(client, runtime, () => {}, () => {}, { root: ROOT, manual: true, inspector: f.inspector, now: () => clock, timing: { windowMs: 1_000, idleRetryMs: 100 } });
    stopping.push(runtime, profiler);
    const starts = () => f.calls.filter((c) => c === "Profiler.start").length;
    /** Time passes with the loop free (ticks on time), timers included. */
    const pass = async (ms: number) => {
      for (let t = 0; t < ms; t += RUNTIME.tickMs) {
        clock += RUNTIME.tickMs;
        runtime.tick();
        await vi.advanceTimersByTimeAsync(RUNTIME.tickMs);
      }
    };
    /** The loop is blocked for ms. */
    const block = async (ms: number) => {
      clock += RUNTIME.tickMs + ms;
      runtime.tick();
      await vi.advanceTimersByTimeAsync(0);
    };
    return { runtime, profiler, starts, pass, block, at: () => clock };
  }

  it("a block starts a window at once when idle; another block soon after does not", async () => {
    const s = blockSetup();
    await s.profiler.start();
    await s.pass(200);
    expect(s.starts()).toBe(0);
    await s.block(300);
    await s.pass(1_500);
    expect(s.starts()).toBe(1);
    await s.pass(60_000);
    await s.block(300);
    await s.pass(1_500);
    expect(s.starts()).toBe(1);
  });

  it("at most one extra window per 5 min: after 5 min a block starts another", async () => {
    const s = blockSetup();
    await s.profiler.start();
    await s.block(300);
    await s.pass(1_500);
    await s.pass(5 * 60_000);
    await s.block(250);
    await s.pass(1_500);
    expect(s.starts()).toBe(2);
  });

  it("no extra window when a window started in the last 5 min", async () => {
    const s = blockSetup();
    await s.profiler.start();
    const regular = s.profiler.cpuWindow(1_000);
    await s.pass(1_500);
    await regular;
    expect(s.starts()).toBe(1);
    await s.pass(2 * 60_000);
    await s.block(400);
    await s.pass(1_500);
    expect(s.starts()).toBe(1);
  });

  it("waits for the next idle moment: not while a request is in flight", async () => {
    const s = blockSetup();
    await s.profiler.start();
    const r = { headersSent: false, destroyed: false, writableFinished: false } as unknown as http.ServerResponse;
    s.runtime.requestStart(r, "/docs");
    await s.block(300);
    await s.pass(800);
    expect(s.starts()).toBe(0);
    s.runtime.requestFinish(r, "/docs");
    await s.pass(500);
    expect(s.starts()).toBe(1);
  });

  it("an extra window that never found an idle moment still counts: no second try within 5 min", async () => {
    const s = blockSetup();
    await s.profiler.start();
    const r = { headersSent: false, destroyed: false, writableFinished: false } as unknown as http.ServerResponse;
    s.runtime.requestStart(r, "/docs");
    await s.block(300);
    // Busy for longer than the 60 s idle wait: that window is skipped.
    await s.pass(61_000);
    s.runtime.requestFinish(r, "/docs");
    await s.pass(60_000);
    await s.block(300);
    await s.pass(1_500);
    expect(s.starts()).toBe(0);
  });

  it("blocks under the threshold never start one", async () => {
    const s = blockSetup();
    await s.profiler.start();
    await s.block(RUNTIME.blockMinMs - 10);
    await s.pass(1_500);
    expect(s.starts()).toBe(0);
  });
});

describe("the SDK's own frames are grouped as (abigaail)", () => {
  const cf = (url: string) => ({ functionName: "sample", url, lineNumber: 41 });
  it("this package, its siblings and any installed @abigaail package; the app's files stay as they are", () => {
    const own = pathToFileURL(path.join(ROOT, "packages/node/src/runtime.ts")).href;
    expect(isSdkUrl(own)).toBe(true);
    expect(profileFrame(cf(own), ROOT)).toEqual({ file: "(abigaail)", line: 0 });
    expect(profileFrame(cf("file:///srv/app/node_modules/@abigaail/core/dist/client.js"), "/srv/app")).toEqual({ file: "(abigaail)", line: 0 });
    expect(profileFrame(cf("file:///srv/app/src/report.js"), "/srv/app")).toEqual({ file: "src/report.js", line: 42, fn: "sample" });
    expect(profileFrame(cf("file:///srv/app/node_modules/express/lib/router.js"), "/srv/app")).toEqual({ file: "node_modules/express/lib/router.js", line: 42, fn: "sample" });
  });
});

describe("bounded payloads", () => {
  it("a profile with thousands of distinct stacks is cut to the limits and stays valid", async () => {
    const nodes = [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [] as number[] }];
    const samples: number[] = [];
    for (let i = 0; i < 3000; i++) {
      const id = i + 2;
      nodes[0]!.children.push(id);
      nodes.push({ id, callFrame: { functionName: `handler${i}`, url: pathToFileURL(path.join(ROOT, `src/very/long/directory/name/for/module${i}.ts`)).href, lineNumber: i }, children: [] });
      for (let k = 0; k <= i % 5; k++) samples.push(id);
    }
    const s = setup({ inspector: fakeInspector({ profile: { nodes, startTime: 0, samples, timeDeltas: samples.map(() => 100) } }).inspector });
    await s.profiler.start();
    await s.profiler.cpuWindow(5);
    s.profiler.send();
    const [app] = s.profiles();
    expect(app!.frames.length).toBeLessThanOrEqual(100);
    expect(app!.stacks.length).toBeLessThanOrEqual(150);
    expect(JSON.stringify(app).length).toBeLessThanOrEqual(16 * 1024);
    // Everything is still counted, in the heaviest stacks first.
    expect(app!.samples).toBe(samples.length);
    expect(validateBatch(s.asBatch())).toMatchObject({ ok: true });
  });

  it("many stacks over a few functions are cut to 150 stacks", async () => {
    const nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children: number[] }[] = [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [] },
    ];
    const samples: number[] = [];
    const url = (i: number) => pathToFileURL(path.join(ROOT, `src/m${i}.ts`)).href;
    let next = 2;
    // 20 functions, every ordered pair a distinct two-frame stack: 380 stacks.
    for (let i = 0; i < 20; i++) {
      const outer = next++;
      nodes[0]!.children.push(outer);
      nodes.push({ id: outer, callFrame: { functionName: `f${i}`, url: url(i), lineNumber: 1 }, children: [] });
      for (let j = 0; j < 20; j++) {
        if (j === i) continue;
        const inner = next++;
        nodes.find((n) => n.id === outer)!.children.push(inner);
        nodes.push({ id: inner, callFrame: { functionName: `f${j}`, url: url(j), lineNumber: 1 }, children: [] });
        samples.push(inner);
      }
    }
    const s = setup({ inspector: fakeInspector({ profile: { nodes, startTime: 0, samples, timeDeltas: samples.map(() => 100) } }).inspector });
    await s.profiler.start();
    await s.profiler.cpuWindow(5);
    s.profiler.send();
    const [app] = s.profiles();
    expect(app!.frames.length).toBeLessThanOrEqual(20);
    expect(app!.stacks).toHaveLength(150);
    expect(validateBatch(s.asBatch())).toMatchObject({ ok: true });
  });
});
