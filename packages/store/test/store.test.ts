import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashIngestKey, INGEST_KEY_RE, openStore, type IngestBatch, type Store } from "@abigaail/store";
import type { AbigaailEvent, RequestEvent } from "@abigaail/schema";

let dir: string;
let store: Store;
let t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-store-"));
  store = openStore(join(dir, "test.db"), { now: () => t });
});

/** Query the database file over a separate connection, bypassing the Store API. */
function raw<T>(sql: string): T[] {
  const db = new DatabaseSync(join(dir, "test.db"), { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function id(): string {
  return `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

const request = (event_id = id()): RequestEvent => ({
  type: "request", event_id, client_ts: 1, method: "GET", route: "/user/[id]", status: 200, duration_ms: 3,
});

function batch(events: AbigaailEvent[], overrides: Partial<IngestBatch> = {}): IngestBatch {
  return {
    receivedAt: 5_000,
    release: "abc123",
    environment: "staging",
    events: events.map((event) => ({ event, derived: { ts: 4_000 } })),
    ...overrides,
  };
}

describe("apps and keys", () => {
  it("returns an abk_ key once and stores only its SHA-256", () => {
    const { app, key } = store.createApp("the-well", "test");
    expect(key).toMatch(INGEST_KEY_RE);
    expect(store.appByKey(key)?.id).toBe(app.id);
    expect(store.appByKey(key + "x")).toBeUndefined();

    const dump = JSON.stringify(raw("SELECT * FROM apps"));
    expect(dump).not.toContain(key);
    expect(dump).toContain(hashIngestKey(key));
  });

  it("rejects app names that are not simple slugs", () => {
    expect(() => store.createApp("The Well", "test")).toThrow();
    expect(() => store.createApp("", "test")).toThrow();
  });

  it("disables an app once and audits create and disable without the key", () => {
    const { app, key } = store.createApp("demo", "cli");
    t = 2_000;
    expect(store.disableApp("demo", "cli")).toBe(true);
    expect(store.disableApp("demo", "cli")).toBe(false);
    expect(store.disableApp("missing", "cli")).toBe(false);
    expect(store.appByKey(key)?.disabled_at).toBe(2_000);

    const audit = store.listAudit();
    expect(audit.map((a) => [a.action, a.actor, a.app_id])).toEqual([
      ["app.disable", "cli", app.id],
      ["app.create", "cli", app.id],
    ]);
    expect(JSON.stringify(audit)).not.toContain(key);
  });
});

describe("events", () => {
  it("is idempotent on event_id and counts duplicates", () => {
    const { app } = store.createApp("a", "test");
    const events = [request(), request()];
    expect(store.insertBatch(app.id, batch(events))).toEqual({ inserted: 2, duplicates: 0 });
    expect(store.insertBatch(app.id, batch(events))).toEqual({ inserted: 0, duplicates: 2 });
    const same = request();
    expect(store.insertBatch(app.id, batch([same, same]))).toEqual({ inserted: 1, duplicates: 1 });
    expect(store.countEvents(app.id)).toBe(3);
  });

  it("scopes every read by app_id", () => {
    const a = store.createApp("a", "test").app;
    const b = store.createApp("b", "test").app;
    store.insertBatch(a.id, batch([request(), request()], { release: "rel-a" }));
    store.insertBatch(b.id, batch([request()], { release: "rel-b" }));

    expect(store.countEvents(a.id)).toBe(2);
    expect(store.countEvents(b.id)).toBe(1);
    expect(store.recentEvents(b.id)).toHaveLength(1);
    expect(store.recentEvents(b.id)[0]!.release).toBe("rel-b");
    expect(store.deploys(b.id).map((d) => d.release)).toEqual(["rel-b"]);
  });

  it("does not let the same event_id in another app count as a duplicate", () => {
    const a = store.createApp("a", "test").app;
    const b = store.createApp("b", "test").app;
    const e = request();
    store.insertBatch(a.id, batch([e]));
    expect(store.insertBatch(b.id, batch([e]))).toEqual({ inserted: 1, duplicates: 0 });
  });

  it("maps each type to named columns and never stores transient", () => {
    const { app } = store.createApp("a", "test");
    store.insertBatch(app.id, {
      receivedAt: 5_000,
      release: "r1",
      environment: "staging",
      events: [
        {
          event: { ...request(), flags: ["scanner_path"], referrer_domain: "example.com",
            transient: { ip: "198.51.100.23", ua: "Mozilla/5.0 storetest-7q" } },
          derived: { ts: 4_000, visitor_hash: "ab".repeat(16), browser: "chrome", bot_class: "human" },
        },
        { event: { type: "metric", event_id: id(), client_ts: 1, name: "cpu_percent", value: 12.5 }, derived: { ts: 4_100 } },
        { event: { type: "error", event_id: id(), client_ts: 1, error_type: "TypeError", handled: false,
            frames: [{ file: "src/a.ts", line: 3 }] }, derived: { ts: 4_200 } },
      ],
    });
    const rows = store.recentEvents(app.id);
    const req = rows.find((r) => r.type === "request")!;
    expect(req).toMatchObject({ route: "/user/[id]", status: 200, ts: 4_000, received_at: 5_000, browser: "chrome" });
    expect(JSON.parse(req.attrs!)).toEqual({ referrer_domain: "example.com", flags: ["scanner_path"] });
    expect(rows.find((r) => r.type === "metric")).toMatchObject({ name: "cpu_percent", value: 12.5 });
    expect(rows.find((r) => r.type === "error")).toMatchObject({ name: "TypeError" });

    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("198.51.100.23");
    expect(dump).not.toContain("storetest-7q");
  });

  it("records deploys and last_event_at per app", () => {
    const { app } = store.createApp("a", "test");
    store.insertBatch(app.id, batch([request()], { receivedAt: 5_000, release: "r1" }));
    store.insertBatch(app.id, batch([request()], { receivedAt: 6_000, release: "r1" }));
    store.insertBatch(app.id, batch([request()], { receivedAt: 7_000, release: "r2" }));
    expect(store.deploys(app.id)).toEqual([
      { release: "r1", environment: "staging", first_seen: 5_000, last_seen: 6_000 },
      { release: "r2", environment: "staging", first_seen: 7_000, last_seen: 7_000 },
    ]);
    expect(store.appByName("a")?.last_event_at).toBe(7_000);
  });
});

describe("salts", () => {
  it("keeps one salt per UTC day and deletes earlier days", () => {
    const d1 = store.saltFor("2026-10-17");
    expect(store.saltFor("2026-10-17").equals(d1)).toBe(true);
    const d2 = store.saltFor("2026-10-18");
    expect(d2.equals(d1)).toBe(false);
    const days = raw<{ day: string }>("SELECT day FROM salts").map((r) => r.day);
    expect(days).toEqual(["2026-10-18"]);
  });
});

describe("migrations", () => {
  it("reopening an existing database does not re-run migrations or lose data", () => {
    const { app } = store.createApp("a", "test");
    store.insertBatch(app.id, batch([request()]));
    store.close();
    store = openStore(join(dir, "test.db"));
    expect(store.countEvents(app.id)).toBe(1);
  });
});
