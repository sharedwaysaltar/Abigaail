import { describe, expect, it } from "vitest";
import { validateBatch } from "@abigaail/schema/validate";

const ID = "3f2b8c1e-9a4d-4e7f-8b2a-1c5d6e7f8a9b";

function batch(events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sdk: { name: "@abigaail/core", version: "0.1.0" },
    release: "abc123",
    environment: "staging",
    events,
    ...overrides,
  };
}

const request = {
  type: "request",
  event_id: ID,
  client_ts: 1_700_000_000_000,
  method: "GET",
  route: "/user/[id]",
  status: 200,
  duration_ms: 12.5,
};

describe("validateBatch: accepts valid events", () => {
  it("accepts every event type", () => {
    const result = validateBatch(
      batch([
        { ...request, transient: { ip: "203.0.113.7", ua: "Mozilla/5.0" }, referrer_domain: "example.com" },
        { type: "error", event_id: ID, client_ts: 1, error_type: "TypeError", handled: false, route: "/api/chat",
          frames: [{ file: "src/app/api/chat/route.ts", line: 10, col: 4, fn: "POST" }] },
        { type: "outbound", event_id: ID, client_ts: 1, host: "api.stripe.com", method: "POST", status: 200, duration_ms: 80, outcome: "ok" },
        { type: "metric", event_id: ID, client_ts: 1, name: "event_loop_lag_p99_ms", value: 4.2 },
        { type: "lifecycle", event_id: ID, client_ts: 1, kind: "boot" },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts the 'other' and 'unmatched' route placeholders", () => {
    expect(validateBatch(batch([{ ...request, route: "other" }])).ok).toBe(true);
    expect(validateBatch(batch([{ ...request, route: "unmatched" }])).ok).toBe(true);
  });
});

describe("validateBatch: rejects forbidden data", () => {
  const forbidden: Record<string, unknown> = {
    email: "jane@example.com",
    user_id: "u_123",
    body: "{\"password\":\"hunter2\"}",
    headers: { authorization: "Bearer secret" },
    cookie: "session=abc",
    authorization: "Bearer secret",
    query: "token=abc",
    message: "free text from a user",
    ip: "203.0.113.7",
    url: "https://app.example.com/reset?token=abc",
  };

  for (const [field, value] of Object.entries(forbidden)) {
    it(`rejects a request event carrying "${field}"`, () => {
      const result = validateBatch(batch([{ ...request, [field]: value }]));
      expect(result.ok).toBe(false);
    });
  }

  it("rejects unknown fields at the batch level", () => {
    expect(validateBatch(batch([request], { user: { email: "a@b.c" } })).ok).toBe(false);
  });

  it("rejects unknown fields inside transient and frames", () => {
    expect(validateBatch(batch([{ ...request, transient: { ip: "203.0.113.7", cookie: "x" } }])).ok).toBe(false);
    const error = { type: "error", event_id: ID, client_ts: 1, error_type: "Error", handled: true,
      frames: [{ file: "src/a.ts", line: 1, source: "const password = 'x'" }] };
    expect(validateBatch(batch([error])).ok).toBe(false);
  });

  it("rejects an error message smuggled into error_type", () => {
    const error = { type: "error", event_id: ID, client_ts: 1, handled: true,
      error_type: "Invalid password for jane@example.com" };
    expect(validateBatch(batch([error])).ok).toBe(false);
  });

  it("rejects absolute frame paths (they leak usernames)", () => {
    for (const file of ["/home/jane/app/src/a.ts", "/Users/jane/app/a.ts", "C:\\Users\\jane\\a.ts", "C:/Users/jane/a.ts"]) {
      const error = { type: "error", event_id: ID, client_ts: 1, error_type: "Error", handled: true, frames: [{ file, line: 1 }] };
      expect(validateBatch(batch([error])).ok, file).toBe(false);
    }
  });

  it("rejects raw URLs and query strings as routes", () => {
    for (const route of [
      "/reset?token=abc",
      "https://example.com/a",
      "/user/jane@example.com",
      "/search#q",
      "/a b",
      "/caf%C3%A9",
      "user/[id]",
    ]) {
      expect(validateBatch(batch([{ ...request, route }])).ok, route).toBe(false);
    }
  });

  it("rejects full URLs as referrer or outbound host", () => {
    expect(validateBatch(batch([{ ...request, referrer_domain: "https://example.com/page?x=1" }])).ok).toBe(false);
    const outbound = { type: "outbound", event_id: ID, client_ts: 1, method: "GET", duration_ms: 1, outcome: "ok",
      host: "api.example.com/v1/users?email=a@b.c" };
    expect(validateBatch(batch([outbound])).ok).toBe(false);
  });

  it("rejects a transient ip that is not an IP address", () => {
    expect(validateBatch(batch([{ ...request, transient: { ip: "jane@example.com" } }])).ok).toBe(false);
  });

  it("never echoes the rejected value in its issues", () => {
    const secret = "sk_live_51HxSECRETVALUE";
    const result = validateBatch(batch([{ ...request, api_key: secret, route: `/x?k=${secret}` }]));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("api_key"))).toBe(true);
  });
});

describe("validateBatch: envelope rules", () => {
  it("rejects unsupported schema versions", () => {
    expect(validateBatch(batch([request], { schema_version: 99 })).ok).toBe(false);
    expect(validateBatch(batch([request], { schema_version: 0 })).ok).toBe(false);
  });

  it("accepts an optional integer sent_at and rejects anything else", () => {
    expect(validateBatch(batch([request], { sent_at: 1_700_000_000_500 })).ok).toBe(true);
    expect(validateBatch(batch([request], { sent_at: -1 })).ok).toBe(false);
    expect(validateBatch(batch([request], { sent_at: "now" })).ok).toBe(false);
  });

  it("requires a uuid event_id", () => {
    expect(validateBatch(batch([{ ...request, event_id: "1" }])).ok).toBe(false);
  });

  it("rejects empty and oversized batches", () => {
    expect(validateBatch(batch([])).ok).toBe(false);
    expect(validateBatch(batch(Array.from({ length: 501 }, () => request))).ok).toBe(false);
  });

  it("rejects free-text release strings and unknown environments", () => {
    expect(validateBatch(batch([request], { release: "release for jane smith" })).ok).toBe(false);
    expect(validateBatch(batch([request], { environment: "prod-eu" })).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    for (const input of [null, undefined, "x", 42, []]) expect(validateBatch(input).ok).toBe(false);
  });
});

describe("validateBatch: parent_id", () => {
  const outbound = { type: "outbound", event_id: ID, client_ts: 1, host: "api.stripe.com", method: "POST", duration_ms: 80, outcome: "ok" };
  const error = { type: "error", event_id: ID, client_ts: 1, error_type: "TypeError", handled: true };

  it("accepts a UUID parent_id on outbound and error events", () => {
    expect(validateBatch(batch([{ ...outbound, parent_id: ID }, { ...error, parent_id: ID }])).ok).toBe(true);
  });

  it("rejects a parent_id that is not a UUID, and on other event types", () => {
    expect(validateBatch(batch([{ ...outbound, parent_id: "jane@example.com" }])).ok).toBe(false);
    expect(validateBatch(batch([{ ...error, parent_id: "session-123" }])).ok).toBe(false);
    expect(validateBatch(batch([{ ...request, parent_id: ID }])).ok).toBe(false);
  });
});

describe("validateBatch: region", () => {
  const boot = { type: "lifecycle", event_id: ID, client_ts: 1, kind: "boot" };

  it("accepts a region code on boot", () => {
    expect(validateBatch(batch([{ ...boot, region: "LON1" }])).ok).toBe(true);
    expect(validateBatch(batch([{ ...boot, region: "US-EAST-1" }])).ok).toBe(true);
  });

  it("rejects a region on any other lifecycle kind", () => {
    const r = validateBatch(batch([{ ...boot, kind: "heartbeat", region: "LON1" }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.path).toBe("events.0.region");
  });

  it("rejects free text, lowercase and oversized codes without echoing them", () => {
    for (const region of ["lon1", "London office", "LON1; DROP", "A", "X".repeat(25), "jane@example.com"]) {
      const r = validateBatch(batch([{ ...boot, region }]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.issues)).not.toContain(region);
    }
  });

  it("rejects a region on other event types", () => {
    expect(validateBatch(batch([{ ...request, region: "LON1" }])).ok).toBe(false);
  });
});

describe("validateBatch: error messages, codes and causes (DECISIONS #103)", () => {
  const error = (o: Record<string, unknown>) => ({ type: "error", event_id: ID, client_ts: 1, error_type: "Error", handled: true, ...o });

  it("accepts scrubbed text and pattern codes", () => {
    const ok = validateBatch(batch([
      error({ message: "User <email> not found", code: "P2025", cause_type: "TypeError", cause_code: "ECONNREFUSED", cause_message: "fetch failed", scrub_version: 1 }),
      { type: "outbound", event_id: ID, client_ts: 1, host: "a.example", method: "GET", duration_ms: 1, outcome: "error", error_code: "ENOTFOUND" },
    ]));
    expect(ok.ok).toBe(true);
  });

  it.each([
    ["a code that is not one", { code: "jane@example.com" }],
    ["a name as a code", { code: "JANE_SMITH" }],
    ["a message over 200 characters", { message: "x".repeat(201) }],
    ["an empty message", { message: "" }],
    ["a cause type that is not a class name", { cause_type: "not a class" }],
    ["an unknown field next to them", { message: "fetch failed", detail: "Key (email)=(jane@example.com)" }],
  ])("refuses %s, naming the field but never the value", (_label, extra) => {
    const r = validateBatch(batch([error(extra)]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.issues)).not.toContain("jane");
  });
});
