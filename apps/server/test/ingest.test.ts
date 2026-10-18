import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batch, post, requestEvent, startServer, T0, uuid, type TestServer } from "./helpers.js";

let s: TestServer;
let key: string;
let appId: string;

beforeEach(async () => {
  s = await startServer();
  ({ key, app: { id: appId } } = s.store.createApp("demo", "test"));
});

afterEach(async () => {
  await s.close();
});

describe("accepting batches", () => {
  it("stores a valid batch and answers 202 with counts", async () => {
    const res = await post(s, batch([requestEvent(), requestEvent({ status: 500 })]), { key });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ accepted: 2, duplicates: 0 });
    expect(s.store.countEvents(appId)).toBe(2);
    expect(s.store.deploys(appId).map((d) => d.release)).toEqual(["abc123"]);
  });

  it("is idempotent: resending the same batch stores nothing new", async () => {
    const b = batch([requestEvent(), requestEvent()]);
    await post(s, b, { key });
    const again = await post(s, b, { key });
    expect(again.status).toBe(202);
    expect(again.json).toEqual({ accepted: 0, duplicates: 2 });
    expect(s.store.countEvents(appId)).toBe(2);
  });

  it("accepts application/json with a charset parameter", async () => {
    const res = await post(s, batch([requestEvent()]), { key, contentType: "application/json; charset=utf-8" });
    expect(res.status).toBe(202);
  });

  it("updates last_event_at on an accepted batch only", async () => {
    await post(s, batch([{ ...requestEvent(), email: "a@b.c" }]), { key });
    expect(s.store.appByName("demo")?.last_event_at).toBeNull();
    s.clock.now = T0 + 1000;
    await post(s, batch([requestEvent()]), { key });
    expect(s.store.appByName("demo")?.last_event_at).toBe(T0 + 1000);
  });
});

describe("rejecting batches (nothing is stored)", () => {
  for (const field of ["email", "headers", "body", "cookie", "user_id", "url"]) {
    it(`rejects a request event carrying "${field}" with 400`, async () => {
      const res = await post(s, batch([requestEvent(), { ...requestEvent(), [field]: "secret-value" }]), { key });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid_batch");
      expect(JSON.stringify(res.json)).not.toContain("secret-value");
      expect(s.store.countEvents(appId)).toBe(0);
    });
  }

  it("rejects an unsupported schema_version", async () => {
    const res = await post(s, batch([requestEvent()], { schema_version: 99 }), { key });
    expect(res.status).toBe(400);
    expect(s.store.countEvents(appId)).toBe(0);
  });

  it("rejects malformed JSON", async () => {
    const res = await post(s, "{not json", { key });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_json");
  });

  it("rejects non-JSON content types with 415", async () => {
    const res = await post(s, batch([requestEvent()]), { key, contentType: "text/plain" });
    expect(res.status).toBe(415);
    expect(s.store.countEvents(appId)).toBe(0);
  });
});

describe("keys", () => {
  it("answers 401 for a missing or unknown key", async () => {
    expect((await post(s, batch([requestEvent()]))).status).toBe(401);
    expect((await post(s, batch([requestEvent()]), { key: "abk_wrong" })).status).toBe(401);
    expect(s.store.countEvents(appId)).toBe(0);
  });

  it("answers 403 once the app is disabled, and audits create and disable", async () => {
    expect((await post(s, batch([requestEvent()]), { key })).status).toBe(202);
    s.store.disableApp("demo", "cli");
    const res = await post(s, batch([requestEvent()]), { key });
    expect(res.status).toBe(403);
    expect(s.store.countEvents(appId)).toBe(1);
    expect(s.store.listAudit().map((a) => a.action)).toEqual(["app.disable", "app.create"]);
  });
});

describe("internal errors", () => {
  it("answers 500 and logs the error class name only, never its message", async () => {
    await s.close();
    const logs: string[] = [];
    s = await startServer({ log: (m) => logs.push(m) });
    s.store.appByKey = () => {
      throw new TypeError("leaky message abk_secret 203.0.113.9");
    };
    const res = await post(s, batch([requestEvent()]), { key: "abk_any" });
    expect(res.status).toBe(500);
    expect(logs).toEqual(["ingest: internal error (TypeError)"]);
  });
});

describe("salt failures", () => {
  it("still accepts events, with a null visitor hash and one clear log line", async () => {
    await s.close();
    const logs: string[] = [];
    s = await startServer({
      log: (m) => logs.push(m),
      salt: {
        forDay() {
          throw Object.assign(new Error("EROFS: read-only file system"), { name: "Error" });
        },
      },
    });
    ({ key, app: { id: appId } } = s.store.createApp("demo", "test"));
    const visit = () => requestEvent({ transient: { ip: "203.0.113.5", ua: "x" } });
    expect((await post(s, batch([visit()]), { key })).status).toBe(202);
    expect((await post(s, batch([visit()]), { key })).status).toBe(202);
    expect(s.store.recentEvents(appId).map((e) => e.visitor_hash)).toEqual([null, null]);
    expect(logs).toEqual(["salt rotation failed (Error); visitor hashes are null until it succeeds"]);
  });
});

describe("routing", () => {
  it("serves /healthz and rejects other paths and methods", async () => {
    expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${s.url}/ingest`)).status).toBe(405);
    expect((await post(s, batch([requestEvent()]), { key, path: "/elsewhere" })).status).toBe(404);
  });

  it("ignores a query string on /ingest", async () => {
    expect((await post(s, batch([requestEvent()]), { key, path: "/ingest?x=1" })).status).toBe(202);
  });
});

describe("rate limits", () => {
  it("limits batches per app with 429 and retry-after", async () => {
    await s.close();
    s = await startServer({ appRate: { perSec: 1, burst: 2 } });
    ({ key, app: { id: appId } } = s.store.createApp("demo", "test"));
    expect((await post(s, batch([requestEvent()]), { key })).status).toBe(202);
    expect((await post(s, batch([requestEvent()]), { key })).status).toBe(202);
    const limited = await post(s, batch([requestEvent()]), { key });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    s.clock.now += 1000;
    expect((await post(s, batch([requestEvent()]), { key })).status).toBe(202);
  });

  it("refuses a flood of bad keys with 429 while a valid key keeps working", async () => {
    await s.close();
    s = await startServer({ badKeyRate: { perSec: 1, burst: 3 } });
    ({ key, app: { id: appId } } = s.store.createApp("demo", "test"));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(s, batch([requestEvent()]), { key: `abk_guess${i}` })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    expect((await post(s, batch([requestEvent()]), { key })).status).toBe(202);
  });
});

describe("event time", () => {
  it("uses the client's send delay, not its clock: a clock 3 hours ahead still lands correctly", async () => {
    const skew = 3 * 60 * 60 * 1000;
    const sentAt = T0 + skew;
    const res = await post(
      s,
      batch(
        [
          requestEvent({ event_id: uuid(), client_ts: sentAt - 5000 }),
          requestEvent({ event_id: uuid(), client_ts: sentAt - 48 * 60 * 60 * 1000 }),
          requestEvent({ event_id: uuid(), client_ts: sentAt + 60_000 }),
        ],
        { sent_at: sentAt },
      ),
      { key },
    );
    expect(res.status).toBe(202);
    const times = s.store.recentEvents(appId).map((e) => [e.client_ts - sentAt, e.ts - T0, e.received_at]);
    expect(times).toEqual(
      expect.arrayContaining([
        [-5000, -5000, T0], // waited 5s in the queue
        [-48 * 3600_000, -24 * 3600_000, T0], // clamped to 24h
        [60_000, 0, T0], // "sent before it happened": clamped to receive time
      ]),
    );
  });

  it("uses the receive time when sent_at is absent", async () => {
    await post(s, batch([requestEvent({ client_ts: 1 })]), { key });
    expect(s.store.recentEvents(appId)[0]!.ts).toBe(T0);
  });
});
