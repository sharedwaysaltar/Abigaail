import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type Transport } from "@abigaail/core";
import type { Batch, EventInput } from "@abigaail/schema";

const base = {
  endpoint: "http://127.0.0.1:1/ingest",
  ingestKey: "test-key",
  release: "abc123",
  environment: "test" as const,
  flushIntervalMs: 0,
};

const req = (): EventInput => ({ type: "request", method: "GET", route: "/", status: 200, duration_ms: 1 });
const err = (): EventInput => ({ type: "error", error_type: "TypeError", handled: false });

/** Transport that records batches and answers with a fixed result. */
function recording(result: "ok" | "rejected" | "failed" = "ok") {
  const batches: Batch[] = [];
  const transport: Transport = async (b) => {
    batches.push(b);
    return result;
  };
  return { batches, transport };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("capture", () => {
  it("is synchronous and fills in event_id and client_ts", async () => {
    const { batches, transport } = recording();
    const c = createClient({ ...base, transport, now: () => 42 });
    c.capture(req());
    expect(c.stats().queued).toBe(1);
    await c.flush();
    const e = batches[0]!.events[0]!;
    expect(e.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.client_ts).toBe(42);
    expect(batches[0]!.schema_version).toBe(1);
    expect(batches[0]!.release).toBe("abc123");
  });

  it("never throws, whatever it is given", () => {
    const c = createClient({ ...base, transport: recording().transport });
    for (const bad of [null, undefined, 42, "x", [], { type: "request" }]) {
      expect(() => c.capture(bad as never)).not.toThrow();
    }
  });

  it("does not throw even if the error hook throws", () => {
    const c = createClient({ ...base, endpoint: "", onInternalError: () => { throw new Error("boom"); } });
    expect(() => c.capture(req())).not.toThrow();
  });

  it("returns a no-op client when misconfigured, instead of throwing", async () => {
    const onInternalError = vi.fn();
    const c = createClient({ ...base, ingestKey: "", onInternalError });
    c.capture(req());
    await c.flush();
    expect(c.stats().queued).toBe(0);
    expect(onInternalError).toHaveBeenCalledOnce();
  });

  it("is a no-op when disabled", async () => {
    const { batches, transport } = recording();
    const c = createClient({ ...base, transport, enabled: false });
    c.capture(req());
    await c.flush();
    expect(batches).toHaveLength(0);
  });
});

describe("bounded memory", () => {
  it("drops events beyond maxQueue instead of growing", () => {
    // Threshold 1 disables sampling so this tests the hard cap alone.
    const c = createClient({ ...base, transport: recording().transport, maxQueue: 10, batchSize: 1000, sampleThreshold: 1 });
    for (let i = 0; i < 25; i++) c.capture(err());
    expect(c.stats().queued).toBe(10);
    expect(c.stats().dropped).toBe(15);
  });

  it("samples request events under load but keeps errors", () => {
    const c = createClient({ ...base, transport: recording().transport, maxQueue: 100, batchSize: 1000, random: () => 0.99 });
    for (let i = 0; i < 100; i++) c.capture(req());
    const s = c.stats();
    // Fill passes 50%, then request events are shed.
    expect(s.queued).toBeLessThan(100);
    expect(s.sampledOut).toBeGreaterThan(0);
    const before = s.queued;
    c.capture(err());
    expect(c.stats().queued).toBe(before + 1);
  });

  it("records the sample rate on sampled request events", async () => {
    const { batches, transport } = recording();
    const c = createClient({ ...base, transport, maxQueue: 10, batchSize: 1000, random: () => 0 });
    for (let i = 0; i < 9; i++) c.capture(req());
    await c.flush();
    const rates = batches.flatMap((b) => b.events).map((e) => (e.type === "request" ? e.sample_rate : undefined));
    expect(rates.slice(0, 5).every((r) => r === undefined)).toBe(true);
    expect(rates.slice(6).every((r) => typeof r === "number" && r > 0 && r < 1)).toBe(true);
  });
});

describe("batching", () => {
  it("splits the queue into batches of batchSize", async () => {
    const { batches, transport } = recording();
    const c = createClient({ ...base, transport, batchSize: 10, maxQueue: 1000, sampleThreshold: 1 });
    for (let i = 0; i < 25; i++) c.capture(err());
    await c.flush();
    // A full batch also schedules a microtask flush; wait for it to settle.
    await new Promise((r) => setTimeout(r, 0));
    await c.flush();
    expect(batches.map((b) => b.events.length)).toEqual([10, 10, 5]);
    expect(c.stats().sent).toBe(25);
  });

  it("shares one in-flight flush between concurrent callers", async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return "ok";
    };
    const c = createClient({ ...base, transport });
    c.capture(err());
    await Promise.all([c.flush(), c.flush(), c.flush()]);
    expect(calls).toBe(1);
  });

  it("drops a batch the server rejects as invalid, without retrying", async () => {
    const { batches, transport } = recording("rejected");
    const c = createClient({ ...base, transport });
    c.capture(err());
    await c.flush();
    await c.flush();
    expect(batches).toHaveLength(1);
    expect(c.stats()).toMatchObject({ rejected: 1, queued: 0, breaker: "closed" });
  });
});

describe("fail-open when ingest is down or slow", () => {
  it("flush resolves within the timeout when the transport hangs forever", async () => {
    const hang: Transport = () => new Promise(() => {});
    const c = createClient({ ...base, transport: hang, timeoutMs: 50 });
    c.capture(err());
    const start = performance.now();
    await c.flush();
    expect(performance.now() - start).toBeLessThan(500);
    expect(c.stats().failedSends).toBe(1);
    // Events are kept for a later retry, not lost.
    expect(c.stats().queued).toBe(1);
  });

  it("flush never rejects when the transport throws", async () => {
    const throwing: Transport = () => { throw new Error("socket exploded"); };
    const c = createClient({ ...base, transport: throwing });
    c.capture(err());
    await expect(c.flush()).resolves.toBeUndefined();
    expect(c.stats().failedSends).toBe(1);
  });

  it("works against a real unreachable endpoint with the default fetch transport", async () => {
    // Port 1 on localhost refuses connections.
    const c = createClient({ ...base, timeoutMs: 500 });
    c.capture(err());
    await expect(c.flush()).resolves.toBeUndefined();
    expect(c.stats().failedSends).toBe(1);
  });

  it("capture stays fast while sends hang", async () => {
    const hang: Transport = () => new Promise(() => {});
    const c = createClient({ ...base, transport: hang, timeoutMs: 10_000, maxQueue: 1000, batchSize: 10 });
    void c.flush();
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) c.capture(req());
    // 10k captures with a hung network: well under a millisecond each.
    expect(performance.now() - start).toBeLessThan(500);
    expect(c.stats().queued).toBeLessThanOrEqual(1000);
  });

  it("opens the circuit after 3 failures and stops sending", async () => {
    let calls = 0;
    const failing: Transport = async () => { calls++; return "failed"; };
    const c = createClient({ ...base, transport: failing });
    for (let i = 0; i < 3; i++) {
      c.capture(err());
      await c.flush();
    }
    expect(c.stats().breaker).toBe("open");
    await c.flush();
    await c.flush();
    expect(calls).toBe(3);
  });

  it("probes after the cooldown and closes again on success", async () => {
    let t = 0;
    let result: "ok" | "failed" = "failed";
    let calls = 0;
    const transport: Transport = async () => { calls++; return result; };
    const c = createClient({ ...base, transport, now: () => t, breaker: { baseCooldownMs: 1000, maxCooldownMs: 8000 } });
    for (let i = 0; i < 3; i++) {
      c.capture(err());
      await c.flush();
    }
    expect(c.stats().breaker).toBe("open");

    t = 999;
    await c.flush();
    expect(calls).toBe(3);

    t = 1000;
    expect(c.stats().breaker).toBe("half_open");
    result = "ok";
    await c.flush();
    expect(c.stats()).toMatchObject({ breaker: "closed", queued: 0 });
  });

  it("backs off longer after a failed probe", async () => {
    let t = 0;
    const failing: Transport = async () => "failed";
    const c = createClient({ ...base, transport: failing, now: () => t, breaker: { baseCooldownMs: 1000, maxCooldownMs: 8000 } });
    for (let i = 0; i < 3; i++) {
      c.capture(err());
      await c.flush();
    }
    t = 1000;
    await c.flush(); // probe fails, cooldown doubles to 2000
    t = 2999;
    expect(c.stats().breaker).toBe("open");
    t = 3000;
    expect(c.stats().breaker).toBe("half_open");
  });

  it("retries requeued events without exceeding the queue cap", async () => {
    const c = createClient({ ...base, transport: async () => "failed", maxQueue: 5, batchSize: 5, sampleThreshold: 1 });
    for (let i = 0; i < 5; i++) c.capture(err());
    await c.flush();
    expect(c.stats().queued).toBe(5);
    for (let i = 0; i < 5; i++) c.capture(err());
    expect(c.stats().queued).toBe(5);
  });
});

describe("timer and shutdown", () => {
  it("flushes on the background interval", async () => {
    vi.useFakeTimers();
    const { batches, transport } = recording();
    const c = createClient({ ...base, transport, flushIntervalMs: 5000 });
    c.capture(err());
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches).toHaveLength(1);
    await c.shutdown();
  });

  it("shutdown is bounded even if ingest hangs, and ignores later captures", async () => {
    const hang: Transport = () => new Promise(() => {});
    const c = createClient({ ...base, transport: hang, timeoutMs: 10_000 });
    c.capture(err());
    const start = performance.now();
    await c.shutdown(50);
    expect(performance.now() - start).toBeLessThan(500);
    c.capture(err());
    expect(c.stats().queued).toBe(0);
  });
});
