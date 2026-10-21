import { describe, expect, it } from "vitest";
import { cleanHost, createClient, sanitizeEvent, type Transport } from "@abigaail/core";
import { validateBatch } from "@abigaail/schema/validate";
import type { Batch, EventInput } from "@abigaail/schema";

const base = {
  endpoint: "http://127.0.0.1:1/ingest",
  ingestKey: "test-key",
  release: "abc123",
  environment: "test" as const,
  flushIntervalMs: 0,
};

/** Capture the given inputs and return what the client actually sends. */
async function send(inputs: unknown[]): Promise<{ batch: Batch | undefined; invalid: number }> {
  const batches: Batch[] = [];
  const transport: Transport = async (b) => {
    batches.push(b);
    return "ok";
  };
  const c = createClient({ ...base, transport });
  for (const i of inputs) c.capture(i as EventInput);
  await c.flush();
  return { batch: batches[0], invalid: c.stats().invalid };
}

const outbound = (host: string) => ({ type: "outbound", host, method: "GET", duration_ms: 5, outcome: "ok" });

describe("sanitizeEvent: every queued event is one ingest accepts", () => {
  it("records an IPv6 outbound host as ip-literal", async () => {
    const { batch } = await send([outbound("2001:db8::1"), outbound("[2001:db8::1]"), outbound("10.0.0.7")]);
    expect(validateBatch(batch).ok).toBe(true);
    expect(batch!.events.map((e) => (e as { host: string }).host)).toEqual(["ip-literal", "ip-literal", "ip-literal"]);
  });

  it("maps an underscore host to invalid-host instead of rejecting the batch", async () => {
    const { batch } = await send([outbound("my_service.internal")]);
    expect(validateBatch(batch).ok).toBe(true);
    expect((batch!.events[0] as { host: string }).host).toBe("invalid-host");
  });

  it("drops a frame whose path has a space, keeping the error and the other frames", async () => {
    const { batch } = await send([
      {
        type: "error",
        error_type: "TypeError",
        handled: false,
        frames: [
          { file: "src/my file.ts", line: 1 },
          { file: "src/ok.ts", line: 2, fn: "not an ident" },
        ],
      },
    ]);
    expect(validateBatch(batch).ok).toBe(true);
    expect((batch!.events[0] as { frames: unknown }).frames).toEqual([{ file: "src/ok.ts", line: 2 }]);
  });

  it("removes unknown keys, so a smuggled field never leaves the app", async () => {
    const { batch } = await send([
      { type: "request", method: "GET", route: "/", status: 200, duration_ms: 1, email: "a@b.c", body: "secret" },
    ]);
    expect(validateBatch(batch).ok).toBe(true);
    expect(JSON.stringify(batch)).not.toMatch(/a@b\.c|secret|email|body/);
  });

  it("drops an event with a NaN duration and counts it", async () => {
    const { batch, invalid } = await send([
      { type: "request", method: "GET", route: "/", status: 200, duration_ms: Number.NaN },
      { type: "lifecycle", kind: "boot" },
    ]);
    expect(invalid).toBe(1);
    expect(batch!.events).toHaveLength(1);
    expect(validateBatch(batch).ok).toBe(true);
  });

  it("maps a bad route to other, a bad error type to Error, and unmaps a dual-stack IP", async () => {
    const { batch } = await send([
      {
        type: "request",
        method: "GET",
        route: "/user/a@b.c?x=1",
        status: 200,
        duration_ms: 1,
        referrer_domain: "https://evil.example/path",
        transient: { ip: "::ffff:203.0.113.9", ua: "x".repeat(2000) },
      },
      { type: "error", error_type: "Error: user a@b.c not found", handled: true, route: "/x y" },
    ]);
    expect(validateBatch(batch).ok).toBe(true);
    const [req, err] = batch!.events as unknown as [Record<string, any>, Record<string, any>];
    expect(req.route).toBe("other");
    expect(req.referrer_domain).toBeUndefined();
    expect(req.transient).toEqual({ ip: "203.0.113.9", ua: "x".repeat(512) });
    expect(err.error_type).toBe("Error");
    expect(err.route).toBe("other");
  });

  it("drops unknown types, methods, metric names and lifecycle kinds", () => {
    const id = () => "00000000-0000-4000-8000-000000000000";
    const now = () => 1;
    for (const bad of [
      { type: "pageview" },
      { type: "request", method: "BREW", route: "/", status: 200, duration_ms: 1 },
      { type: "metric", name: "user_count", value: 1 },
      { type: "metric", name: "cpu_percent", value: Infinity },
      { type: "lifecycle", kind: "panic" },
      null,
      "x",
    ]) {
      expect(sanitizeEvent(bad, id, now)).toBeUndefined();
    }
  });

  it("cleanHost lowercases valid hostnames", () => {
    expect(cleanHost("API.Example.com")).toBe("api.example.com");
    expect(cleanHost(undefined)).toBe("invalid-host");
  });
});

describe("sanitizeEvent: parent_id", () => {
  const PARENT = "3f2b8c1e-9a4d-4e7f-8b2a-1c5d6e7f8a9b";

  it("keeps a UUID parent_id on outbound and error events", async () => {
    const { batch } = await send([
      { ...outbound("api.stripe.com"), parent_id: PARENT },
      { type: "error", error_type: "TypeError", handled: true, parent_id: PARENT },
    ]);
    expect(validateBatch(batch).ok).toBe(true);
    expect(batch!.events.map((e) => (e as { parent_id?: string }).parent_id)).toEqual([PARENT, PARENT]);
  });

  it("drops an invalid parent_id but keeps the event, and never puts one on a request", async () => {
    const { batch, invalid } = await send([
      { ...outbound("api.stripe.com"), parent_id: "jane@example.com" },
      { type: "request", method: "GET", route: "/", status: 200, duration_ms: 1, parent_id: PARENT },
    ]);
    expect(invalid).toBe(0);
    expect(validateBatch(batch).ok).toBe(true);
    expect(JSON.stringify(batch)).not.toContain("parent_id");
  });
});

describe("sanitizeEvent: region", () => {
  const boot = (region: unknown, kind = "boot") => ({ type: "lifecycle", kind, region });

  it("uppercases a region code and keeps it on boot", async () => {
    const { batch } = await send([boot(" lon1 ")]);
    expect(batch!.events[0]).toMatchObject({ kind: "boot", region: "LON1" });
    expect(validateBatch(batch).ok).toBe(true);
  });

  it("removes an invalid region but keeps the boot", async () => {
    const { batch, invalid } = await send([boot("London, 3rd floor"), boot(42)]);
    expect(invalid).toBe(0);
    for (const e of batch!.events) expect(e).not.toHaveProperty("region");
    expect(validateBatch(batch).ok).toBe(true);
  });

  it("never puts a region on a heartbeat or shutdown", async () => {
    const { batch } = await send([boot("LON1", "heartbeat"), boot("LON1", "shutdown")]);
    for (const e of batch!.events) expect(e).not.toHaveProperty("region");
    expect(validateBatch(batch).ok).toBe(true);
  });
});

describe("sanitizeEvent: error messages go through the scrubber (DECISIONS #101)", () => {
  const error = (extra: Record<string, unknown>) => ({ type: "error", error_type: "Error", handled: true, ...extra });
  async function sendWith(opts: Partial<Parameters<typeof createClient>[0]>, inputs: unknown[]) {
    const batches: Batch[] = [];
    const c = createClient({ ...base, ...opts, transport: async (b) => (batches.push(b), "ok") });
    for (const i of inputs) c.capture(i as EventInput);
    await c.flush();
    for (const b of batches) expect(validateBatch(b)).toMatchObject({ ok: true });
    return batches.flatMap((b) => b.events);
  }

  it("scrubs the message and cause, keeps codes by pattern, and sends the scrubber version", async () => {
    const [e] = await sendWith({}, [
      error({ message: "User jane@example.com not found", code: "P2025", cause_type: "TypeError", cause_code: "ECONNREFUSED", cause_message: "connect ECONNREFUSED 10.0.0.5:5432" }),
    ]);
    expect(e).toMatchObject({ message: "User <email> not found", code: "P2025", cause_type: "TypeError", cause_code: "ECONNREFUSED", cause_message: "connect ECONNREFUSED <ip>:5432", scrub_version: 1 });
    expect(JSON.stringify(e)).not.toContain("jane");
  });

  it("an unclassifiable message or code is dropped, never sent as it is; the error still goes out", async () => {
    const [e] = await sendWith({}, [error({ message: "Jane Smith", code: "JANE_SMITH", cause_type: "not an ident!" })]);
    expect(e).toMatchObject({ type: "error", error_type: "Error" });
    for (const k of ["message", "code", "cause_type", "scrub_version"]) expect(e).not.toHaveProperty(k);
  });

  it("errorMessages: false sends class names and codes only", async () => {
    const [e] = await sendWith({ errorMessages: false }, [error({ message: "fetch failed", code: "ECONNRESET", cause_message: "socket hang up" })]);
    expect(e).toMatchObject({ code: "ECONNRESET" });
    expect(e).not.toHaveProperty("message");
    expect(e).not.toHaveProperty("cause_message");
  });

  it("past the scrub budget errors go out without their message", async () => {
    let t = 1_000;
    const events = await sendWith({ maxScrubsPerSecond: 3, now: () => t }, Array.from({ length: 10 }, () => error({ message: "fetch failed for the user" })));
    expect(events).toHaveLength(10);
    expect(events.filter((e) => "message" in e)).toHaveLength(3);
    // The budget refills.
    t += 1_000;
    const later = await sendWith({ maxScrubsPerSecond: 3, now: () => t }, [error({ message: "fetch failed for the user" })]);
    expect(later[0]).toHaveProperty("message");
  });

  it("a hostname survives only after the app has called it", async () => {
    const msg = "getaddrinfo ENOTFOUND api.payments.example";
    const before = await sendWith({}, [error({ message: msg })]);
    expect(before[0]).toMatchObject({ message: "getaddrinfo ENOTFOUND <host>" });
    const after = await sendWith({}, [outbound("api.payments.example"), error({ message: msg })]);
    expect(after[1]).toMatchObject({ message: msg });
  });

  it("an outbound failure carries its code; a successful call never does", async () => {
    const events = await sendWith({}, [
      { ...outbound("a.example"), outcome: "error", error_code: "ENOTFOUND" },
      { ...outbound("a.example"), outcome: "ok", error_code: "ENOTFOUND" },
      { ...outbound("a.example"), outcome: "timeout", error_code: "jane@example.com" },
    ]);
    expect(events.map((e) => (e as { error_code?: string }).error_code)).toEqual(["ENOTFOUND", undefined, undefined]);
  });
});
