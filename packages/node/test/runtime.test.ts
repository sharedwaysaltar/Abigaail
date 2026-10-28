// Runtime signals (DECISIONS #110-#114): the features handshake keeps a newer
// SDK compatible with an older server; block attribution blames the request
// that ran through a block, never a long-open stream; the in-flight table and
// everything else stay bounded; the crash record is opt-in, refuses symlinks
// and carries no free text.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AbigaailClient, Transport } from "@abigaail/core";
import { init, instanceId, RUNTIME, RuntimeMonitor, type AbigaailNode } from "@abigaail/node";
import type { AbigaailEvent, Batch, BlockEvent, LifecycleEvent } from "@abigaail/schema";
import { validateBatch } from "@abigaail/schema/validate";

// ---- a monitor on a fake clock ---------------------------------------------

type Res = { headersSent: boolean; destroyed: boolean; writableFinished: boolean };
const res = (over: Partial<Res> = {}) => ({ headersSent: false, destroyed: false, writableFinished: false, ...over }) as unknown as http.ServerResponse;

const monitors: RuntimeMonitor[] = [];
afterEach(() => {
  for (const m of monitors.splice(0)) m.stop();
});

function fakeClient(features: () => string[] | undefined) {
  const events: Record<string, unknown>[] = [];
  const client: AbigaailClient = {
    capture: (e) => void events.push(e as Record<string, unknown>),
    hold: () => {},
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    stats: () => ({ queued: 0, dropped: 0, invalid: 0, sampledOut: 0, sent: 0, rejected: 0, failedSends: 0, unsupported: 0, breaker: "closed" }),
    features: () => {
      const f = features();
      return f && new Set(f);
    },
  };
  return { client, events };
}

function setup(opts: { features?: () => string[] | undefined; crashRecordDir?: string; env?: NodeJS.ProcessEnv } = {}) {
  let t = 0;
  const { client, events } = fakeClient(opts.features ?? (() => ["runtime_v1"]));
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const m = new RuntimeMonitor(
    client,
    (e) => errors.push(e),
    { instanceKey: "abk_test", env: opts.env ?? {}, crashRecordDir: opts.crashRecordDir, peekRoute: (p) => `peek:${p}`, now: () => t, manualTick: true },
    (w) => warnings.push(w),
  );
  monitors.push(m);
  /** Ticks on time up to `to`. */
  const advance = (to: number) => {
    while (t + RUNTIME.tickMs <= to) {
      t += RUNTIME.tickMs;
      m.tick();
    }
  };
  /** The loop is blocked for `ms` from the next due tick. */
  const blockFor = (ms: number) => {
    t += RUNTIME.tickMs + ms;
    m.tick();
  };
  const at = (to: number) => {
    t = to;
  };
  const sample = () => {
    const metrics: [string, number][] = [];
    m.sample(process.memoryUsage(), (name, value) => metrics.push([name, value]));
    return { metrics, blocks: events.filter((e) => e.type === "block") as unknown as BlockEvent[] };
  };
  return { m, events, warnings, errors, advance, blockFor, at, now: () => t, sample };
}

describe("block attribution", () => {
  it("charges the request that ran through the block and finished right after it", () => {
    const s = setup();
    const a = res();
    const b = res();
    s.m.requestStart(a, "/report");
    s.m.requestStart(b, "/search");
    s.advance(100);
    s.blockFor(300);
    s.at(s.now() + 5);
    s.m.requestFinish(a, "/report");
    s.advance(s.now() + 200);
    const { blocks } = s.sample();
    expect(blocks).toEqual([expect.objectContaining({ route: "/report", count: 1, total_ms: 300, max_ms: 300 })]);
  });

  it("charges a synchronous handler whose response finished before the late tick ran", () => {
    const s = setup();
    s.advance(100);
    const a = res();
    s.m.requestStart(a, "/pdf");
    s.at(s.now() + 330);
    // finish runs on a nextTick, before the timers phase sees the block.
    s.m.requestFinish(a, "/pdf");
    s.m.tick();
    s.advance(s.now() + 200);
    expect(s.sample().blocks).toEqual([expect.objectContaining({ route: "/pdf", count: 1 })]);
  });

  it("does not charge a request that finished before the block began", () => {
    const s = setup();
    const a = res();
    s.m.requestStart(a, "/quick");
    s.advance(50);
    s.m.requestFinish(a, "/quick");
    s.advance(400);
    s.blockFor(300);
    s.advance(s.now() + 200);
    const { blocks } = s.sample();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.route).toBeUndefined();
  });

  it("splits a block evenly when no suspect finished with it, using the in-flight route", () => {
    const s = setup();
    s.m.requestStart(res(), "/a");
    s.m.requestStart(res(), "/b");
    s.advance(100);
    s.blockFor(200);
    s.advance(s.now() + 200);
    const { blocks } = s.sample();
    expect(blocks.map((b) => [b.route, b.total_ms, b.max_ms]).sort()).toEqual([
      ["peek:/a", 100, 200],
      ["peek:/b", 100, 200],
    ]);
  });

  it("never blames a long-open stream (SSE) that was in flight during a block", () => {
    const s = setup();
    const sse = res({ headersSent: true });
    s.m.requestStart(sse, "/events");
    s.advance(RUNTIME.streamingMs + 500);
    // A timer blocks the loop: nothing but the stream is in flight.
    s.blockFor(250);
    s.advance(s.now() + 200);
    const { blocks } = s.sample();
    expect(blocks).toEqual([expect.objectContaining({ count: 1, total_ms: 250 })]);
    expect(blocks[0]!.route).toBeUndefined();
  });

  it("still suspects a request that has sent headers but is not yet long-open", () => {
    const s = setup();
    s.m.requestStart(res({ headersSent: true }), "/download");
    s.advance(1000);
    s.blockFor(150);
    s.advance(s.now() + 200);
    expect(s.sample().blocks).toEqual([expect.objectContaining({ route: "peek:/download" })]);
  });

  it("a request that arrives once the loop is free again is not a suspect", () => {
    const s = setup();
    s.advance(100);
    const before = s.now();
    s.blockFor(200);
    // Registered after the late tick, as a request arriving once the loop is free would be.
    s.m.requestStart(res(), "/late");
    s.advance(before + 600);
    const { blocks } = s.sample();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.route).toBeUndefined();
  });

  it("ignores lateness under the block threshold", () => {
    const s = setup();
    s.m.requestStart(res(), "/a");
    s.blockFor(RUNTIME.blockMinMs - 1);
    s.advance(s.now() + 200);
    expect(s.sample().blocks).toEqual([]);
  });

  it("sends at most the top routes per interval, plus the no-request share", () => {
    const s = setup();
    for (let i = 0; i < 8; i++) {
      const r = res();
      s.m.requestStart(r, `/r${i}`);
      s.advance(s.now() + 50);
      s.blockFor(100 + i * 10);
      s.m.requestFinish(r, `/r${i}`);
      s.advance(s.now() + 100);
    }
    s.blockFor(500);
    s.advance(s.now() + 100);
    const { blocks, metrics } = s.sample();
    expect(blocks).toHaveLength(RUNTIME.blockEventsPerInterval + 1);
    expect(blocks.filter((b) => b.route).map((b) => b.route)).toEqual(["/r7", "/r6", "/r5", "/r4", "/r3"]);
    // Distinct blocks, whatever routes they were charged to.
    expect(metrics).toContainEqual(["event_loop_blocks", 9]);
    // Charged blocks are reset per interval.
    expect(s.sample().blocks).toHaveLength(blocks.length);
  });
});

describe("the profiler's own pause (#121)", () => {
  it("is not a block, and is reported as profiler_pause_ms", () => {
    const s = setup();
    s.advance(100);
    const from = s.now();
    s.at(from + RUNTIME.tickMs + 250);
    // The profiler started a CPU window: V8 paused the app 250 ms.
    s.m.notePause(from + 20, from + 270);
    s.m.tick();
    s.advance(s.now() + 200);
    const { blocks, metrics } = s.sample();
    expect(blocks).toEqual([]);
    expect(metrics).toContainEqual(["event_loop_blocks", 0]);
    expect(metrics).toContainEqual(["profiler_pause_ms", 250]);
  });

  it("only the pause is taken out: real blocking around it is still a block", () => {
    const s = setup();
    s.advance(100);
    const from = s.now();
    s.at(from + RUNTIME.tickMs + 450);
    s.m.notePause(from + 20, from + 270);
    s.m.tick();
    s.advance(s.now() + 200);
    expect(s.sample().blocks).toEqual([expect.objectContaining({ count: 1, total_ms: 200 })]);
  });
});

describe("the in-flight table is bounded", () => {
  it("a table full of aborted requests recovers at the next sweep", () => {
    const s = setup();
    const aborted = Array.from({ length: RUNTIME.maxInflight }, () => res());
    for (const r of aborted) s.m.requestStart(r, "/a");
    expect(s.m.inflightSize).toBe(RUNTIME.maxInflight);
    s.m.requestStart(res(), "/b");
    expect(s.m.inflightSize).toBe(RUNTIME.maxInflight);
    // The clients went away: Node destroys their responses, and no finish event comes.
    for (const r of aborted) (r as unknown as Res).destroyed = true;
    s.advance(RUNTIME.sweepMs + 100);
    expect(s.m.inflightSize).toBe(0);
    s.m.requestStart(res(), "/b");
    expect(s.m.inflightSize).toBe(1);
  });

  it("drops entries older than the TTL even if their response never closes", () => {
    const s = setup();
    s.m.requestStart(res(), "/stuck");
    s.advance(RUNTIME.inflightTtlMs - 1000);
    expect(s.m.inflightSize).toBe(1);
    s.advance(RUNTIME.inflightTtlMs + 2 * RUNTIME.sweepMs);
    expect(s.m.inflightSize).toBe(0);
  });

  it("drops finished responses at the sweep too", () => {
    const s = setup();
    s.m.requestStart(res({ writableFinished: true }), "/a");
    s.advance(RUNTIME.sweepMs + 100);
    expect(s.m.inflightSize).toBe(0);
  });
});

describe("only after the server announced runtime_v1", () => {
  it("sends no runtime metric, block or ready to a server that announced nothing", () => {
    const s = setup({ features: () => undefined });
    s.m.booted("6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f");
    s.m.listening("listen");
    s.m.requestStart(res(), "/a");
    s.blockFor(300);
    s.advance(RUNTIME.readyFallbackMs + 2000);
    const { metrics, blocks } = s.sample();
    expect(metrics).toEqual([]);
    expect(blocks).toEqual([]);
    expect(s.events).toEqual([]);
    expect(s.m.instanceField()).toEqual({});
  });

  it("drops ready for good once the server answered without runtime_v1, or after 5 min without an answer", () => {
    const old = setup({ features: () => [] });
    old.m.booted("6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f");
    old.m.listening("listen");
    old.advance(2 * RUNTIME.sweepMs);
    expect(old.events).toEqual([]);

    let features: string[] | undefined;
    const slow = setup({ features: () => features });
    slow.m.booted("6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f");
    slow.m.listening("listen");
    slow.advance(RUNTIME.readyHoldMs + 2 * RUNTIME.sweepMs);
    features = ["runtime_v1"];
    slow.advance(slow.now() + 2 * RUNTIME.sweepMs);
    expect(slow.events).toEqual([]);
  });

  it("sends ready with the boot's id, the startup time, the heap limit and the instance", () => {
    let features: string[] | undefined;
    const s = setup({ features: () => features });
    s.m.booted("6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f");
    s.at(1234);
    s.m.listening("listen");
    expect(s.events).toEqual([]);
    features = ["runtime_v1"];
    s.advance(1234 + 2 * RUNTIME.sweepMs);
    expect(s.events).toEqual([
      expect.objectContaining({
        type: "lifecycle",
        kind: "ready",
        boot_id: "6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f",
        startup_ms: 1234,
        heap_limit_mb: expect.any(Number),
        instance: s.m.instance,
      }),
    ]);
    // Exactly once.
    s.advance(s.now() + 5 * RUNTIME.sweepMs);
    expect(s.events).toHaveLength(1);
    expect(s.m.instanceField()).toEqual({ instance: s.m.instance });
  });

  it("without a listening server sends ready after a minute, with no startup time", () => {
    const s = setup();
    s.m.booted("6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f");
    s.advance(RUNTIME.readyFallbackMs - 2000);
    expect(s.events).toEqual([]);
    s.advance(RUNTIME.readyFallbackMs + 2 * RUNTIME.sweepMs);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.startup_ms).toBeUndefined();
  });

  it("a first request long after start is not a startup time", () => {
    const s = setup();
    s.m.booted("6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f");
    s.advance(RUNTIME.firstRequestStartupMs + 5000);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.startup_ms).toBeUndefined();
  });
});

describe("instance id", () => {
  it("is 12 hex, stable, keyed, and differs per process-manager slot; it never contains the host name", () => {
    const a = instanceId("abk_one", {});
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceId("abk_one", {})).toBe(a);
    expect(instanceId("abk_two", {})).not.toBe(a);
    expect(instanceId("abk_one", { NODE_APP_INSTANCE: "1" })).not.toBe(instanceId("abk_one", { NODE_APP_INSTANCE: "2" }));
    expect(a).not.toContain(os.hostname().toLowerCase().slice(0, 4));
  });
});

// ---- crash record ------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "abigaail-crash-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` and returns the 'exit' listeners it added (calling them is what Node does on exit). */
function exitListenersAdded(fn: () => void): ((code: number) => void)[] {
  const before = new Set(process.listeners("exit"));
  fn();
  return process.listeners("exit").filter((l) => !before.has(l)) as ((code: number) => void)[];
}

const BOOT = "6f1c1d1e-2b2a-4c3d-8e4f-5a6b7c8d9e0f";

describe("crash record (opt-in)", () => {
  it("is off without a directory: no exit listener", () => {
    expect(exitListenersAdded(() => setup())).toEqual([]);
  });

  it("warns once, without the path, when the directory does not exist", () => {
    let s!: ReturnType<typeof setup>;
    expect(exitListenersAdded(() => (s = setup({ crashRecordDir: path.join(dir, "missing") })))).toEqual([]);
    expect(s.warnings).toEqual(["ABIGAAIL_CRASH_RECORD_DIR is not an existing directory; crash records are off"]);
  });

  it("an uncaught error ending the process is reported by the next boot, then the record is deleted", () => {
    let first!: ReturnType<typeof setup>;
    const [onExit] = exitListenersAdded(() => (first = setup({ crashRecordDir: dir })));
    first.m.fatalError("TypeError", { file: "src/orders.ts", line: 42, fn: "placeOrder" });
    onExit!(1);
    const file = path.join(dir, `abigaail-exit-${first.m.instance}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    first.m.stop();

    const next = setup({ crashRecordDir: dir });
    next.m.booted(BOOT);
    next.m.listening("listen");
    expect(next.events[0]).toMatchObject({
      kind: "ready",
      prev_exit: { code: 1, error_type: "TypeError", frame: { file: "src/orders.ts", line: 42, fn: "placeOrder" }, heap_mb: expect.any(Number) },
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a normal exit records code 0 and no error, even after an error the app survived", () => {
    let s!: ReturnType<typeof setup>;
    const [onExit] = exitListenersAdded(() => (s = setup({ crashRecordDir: dir })));
    s.m.fatalError("RangeError", undefined);
    onExit!(0);
    const record = JSON.parse(fs.readFileSync(path.join(dir, `abigaail-exit-${s.m.instance}.json`), "utf8"));
    expect(record).toMatchObject({ v: 1, code: 0 });
    expect(record.error_type).toBeUndefined();
  });

  it("a clean shutdown removes the exit listener: no record", () => {
    let s!: ReturnType<typeof setup>;
    const [onExit] = exitListenersAdded(() => (s = setup({ crashRecordDir: dir })));
    s.m.stop();
    expect(process.listeners("exit")).not.toContain(onExit);
  });

  it("never follows a symlink, writing or reading", () => {
    let s!: ReturnType<typeof setup>;
    const [onExit] = exitListenersAdded(() => (s = setup({ crashRecordDir: dir })));
    const target = path.join(dir, "target.txt");
    // A valid record behind the link: following it would report it.
    fs.writeFileSync(target, JSON.stringify({ v: 1, code: 9 }));
    fs.symlinkSync(target, path.join(dir, `abigaail-exit-${s.m.instance}.json`));
    onExit!(1);
    expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify({ v: 1, code: 9 }));
    s.m.stop();

    const next = setup({ crashRecordDir: dir });
    next.m.booted(BOOT);
    next.m.listening("listen");
    expect(next.events[0]!.prev_exit).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify({ v: 1, code: 9 }));
  });

  it.each([
    ["garbage", "not json at all"],
    ["oversized", JSON.stringify({ v: 1, code: 1, pad: "x".repeat(2000) })],
    ["another version", JSON.stringify({ v: 2, code: 1 })],
    ["no valid code", JSON.stringify({ v: 1, code: "SIGKILL" })],
  ])("ignores a %s record", (_name, content) => {
    const instance = instanceId("abk_test", {});
    fs.writeFileSync(path.join(dir, `abigaail-exit-${instance}.json`), content);
    const s = setup({ crashRecordDir: dir });
    s.m.booted(BOOT);
    s.m.listening("listen");
    expect(s.events[0]!.prev_exit).toBeUndefined();
  });

  it("keeps only valid fields: no free text, no absolute path", () => {
    const instance = instanceId("abk_test", {});
    fs.writeFileSync(
      path.join(dir, `abigaail-exit-${instance}.json`),
      JSON.stringify({ v: 1, code: 7, error_type: "jane.doe@example.com", frame: { file: "/home/jane/app/x.js", line: 3 }, message: "Order for jane@example.com" }),
    );
    const s = setup({ crashRecordDir: dir });
    s.m.booted(BOOT);
    s.m.listening("listen");
    expect(s.events[0]!.prev_exit).toEqual({ code: 7 });
  });

  it("each instance has its own record file", () => {
    const a = setup({ crashRecordDir: dir, env: { NODE_APP_INSTANCE: "0" } });
    const b = setup({ crashRecordDir: dir, env: { NODE_APP_INSTANCE: "1" } });
    expect(a.m.instance).not.toBe(b.m.instance);
  });

  it("removes another instance's record after a week, and keeps a recent one", () => {
    const old = path.join(dir, "abigaail-exit-aaaaaaaaaaaa.json");
    const recent = path.join(dir, "abigaail-exit-bbbbbbbbbbbb.json");
    const unrelated = path.join(dir, "notes.json");
    for (const f of [old, recent, unrelated]) fs.writeFileSync(f, "{}");
    const weekAgo = (Date.now() - RUNTIME.orphanRecordMs - 60_000) / 1000;
    fs.utimesSync(old, weekAgo, weekAgo);
    fs.utimesSync(unrelated, weekAgo, weekAgo);
    setup({ crashRecordDir: dir });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

// ---- through the real adapter ---------------------------------------------------

let adapter: AbigaailNode | undefined;
const servers: http.Server[] = [];
afterEach(async () => {
  await adapter?.shutdown(100);
  adapter = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** What a server without runtime_v1 (chunk 9) accepts: a frozen copy of its event types and names. */
const LEGACY = {
  types: ["request", "error", "outbound", "metric", "lifecycle"],
  metrics: ["memory_rss_mb", "memory_heap_used_mb", "cpu_percent", "event_loop_lag_p50_ms", "event_loop_lag_p99_ms", "sdk_queue_size", "sdk_dropped_events"],
  kinds: ["boot", "heartbeat", "shutdown"],
  lifecycleKeys: ["type", "event_id", "client_ts", "kind", "region"],
};
function legacyAccepts(b: Batch): boolean {
  if (!validateBatch(b).ok) return false;
  return b.events.every((e) => {
    if (!LEGACY.types.includes(e.type)) return false;
    if (e.type === "metric") return LEGACY.metrics.includes(e.name);
    if (e.type === "lifecycle") return LEGACY.kinds.includes(e.kind) && Object.keys(e).every((k) => LEGACY.lifecycleKeys.includes(k));
    return true;
  });
}

const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function start(features: string[] | undefined) {
  const batches: Batch[] = [];
  const transport: Transport = async (b) => {
    batches.push(structuredClone(b));
    if (features === undefined) return legacyAccepts(b) ? "ok" : "rejected";
    return { result: "ok", features };
  };
  adapter = init({
    endpoint: "http://127.0.0.1:9/ingest",
    ingestKey: "abk_test",
    release: "r1",
    environment: "test",
    flushIntervalMs: 0,
    metricsIntervalMs: 200,
    heartbeatIntervalMs: 200,
    transport,
    onInternalError: () => {},
    env: {},
    nodeVersion: "24.0.0",
    routes: ["/block", "/fine"],
  });
  return batches;
}

describe("through the real adapter", () => {
  it("a new SDK against a server that announces nothing loses no batch and sends nothing new", async () => {
    const batches = start(undefined);
    const base = await serve((req, r) => {
      if (req.url === "/block") busy(250);
      r.end("ok");
    });
    await adapter!.flush();
    await fetch(`${base}/block`).then((r) => r.text());
    await sleep(500);
    await adapter!.flush();
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(legacyAccepts(b)).toBe(true);
    const stats = adapter!.stats();
    expect(stats.rejected).toBe(0);
    expect(stats.unsupported).toBe(0);
    const events = batches.flatMap((b) => b.events);
    expect(events.some((e) => e.type === "metric")).toBe(true);
    expect(events.some((e) => e.type === "lifecycle" && e.kind === "heartbeat")).toBe(true);
  });

  it("with runtime_v1: ready names the boot, heartbeats carry the instance, and the blocking route is charged", async () => {
    const batches = start(["runtime_v1"]);
    // The first accepted batch tells the SDK what the server takes.
    await adapter!.flush();
    const base = await serve((req, r) => {
      if (req.url === "/block") busy(300);
      r.end("ok");
    });
    await fetch(`${base}/fine`).then((r) => r.text());
    await fetch(`${base}/block`).then((r) => r.text());
    await sleep(1500);
    await adapter!.flush();
    for (const b of batches) expect(validateBatch(b)).toMatchObject({ ok: true });
    const events = batches.flatMap((b) => b.events) as AbigaailEvent[];
    const boot = events.find((e) => e.type === "lifecycle" && e.kind === "boot") as LifecycleEvent;
    const ready = events.find((e) => e.type === "lifecycle" && e.kind === "ready") as LifecycleEvent;
    expect(boot.instance).toBeUndefined();
    expect(ready).toMatchObject({ boot_id: boot.event_id, instance: expect.stringMatching(/^[0-9a-f]{12}$/), startup_ms: expect.any(Number) });
    const beat = events.find((e) => e.type === "lifecycle" && e.kind === "heartbeat") as LifecycleEvent;
    expect(beat.instance).toBe(ready.instance);
    const blocks = events.filter((e): e is BlockEvent => e.type === "block");
    expect(blocks.find((b) => b.route === "/block")).toMatchObject({ count: 1, max_ms: expect.any(Number) });
    expect(blocks.find((b) => b.route === "/fine")).toBeUndefined();
    const names = new Set(events.flatMap((e) => (e.type === "metric" ? [e.name] : [])));
    for (const n of ["gc_major_count", "gc_pause_ms", "memory_external_mb", "memory_array_buffers_mb", "event_loop_blocks"]) expect(names).toContain(n);
  }, 10_000);

  it("runtimeSignals: false sends nothing new even to a server that takes it", async () => {
    const batches: Batch[] = [];
    adapter = init({
      endpoint: "http://127.0.0.1:9/ingest",
      ingestKey: "abk_test",
      release: "r1",
      environment: "test",
      flushIntervalMs: 0,
      metricsIntervalMs: 100,
      heartbeatIntervalMs: 100,
      transport: async (b) => {
        batches.push(structuredClone(b));
        return { result: "ok", features: ["runtime_v1"] };
      },
      onInternalError: () => {},
      env: {},
      nodeVersion: "24.0.0",
      runtimeSignals: false,
    });
    await adapter.flush();
    await sleep(400);
    await adapter.flush();
    for (const b of batches) expect(legacyAccepts(b)).toBe(true);
  });
});
