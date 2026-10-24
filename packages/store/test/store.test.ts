import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashIngestKey, INGEST_KEY_RE, MIGRATIONS, openStore, type IngestBatch, type Store } from "@abigaail/store";
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
    expect(store.insertBatch(app.id, batch(events))).toMatchObject({ inserted: 2, duplicates: 0 });
    expect(store.insertBatch(app.id, batch(events))).toMatchObject({ inserted: 0, duplicates: 2 });
    const same = request();
    expect(store.insertBatch(app.id, batch([same, same]))).toMatchObject({ inserted: 1, duplicates: 1 });
    expect(store.countEvents(app.id)).toBe(3);
  });

  it("returns only the rows it inserted, so a retry is never reported twice", () => {
    const { app } = store.createApp("a", "test");
    const events = [request(), request()];
    expect(store.insertBatch(app.id, batch(events)).rows.map((r) => r.event_id)).toEqual(events.map((e) => e.event_id));
    const fresh = request();
    expect(store.insertBatch(app.id, batch([events[0]!, fresh, events[1]!])).rows.map((r) => r.event_id)).toEqual([fresh.event_id]);
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
    expect(store.insertBatch(b.id, batch([e]))).toMatchObject({ inserted: 1, duplicates: 0 });
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

describe("migrations", () => {
  it("migration 2 drops the salts table and erases salts deleted before secure_delete existed", () => {
    store.close();
    const path = join(dir, "v1.db");
    // A database as the first chunk 2 build left it: version 1, secure_delete
    // off, one current salt and rotated-out ones that were deleted but are
    // still on disk. Enough old rows to span several pages, so after the
    // delete some old salt bytes sit in pages already on the free list, which
    // DROP TABLE + secure_delete does not touch; only VACUUM removes those.
    const v1 = new DatabaseSync(path);
    v1.exec("PRAGMA journal_mode = WAL; PRAGMA secure_delete = OFF;");
    v1.exec(MIGRATIONS[0]!);
    v1.exec("PRAGMA user_version = 1");
    const oldSalts = Array.from({ length: 400 }, () => randomBytes(32));
    const current = randomBytes(32);
    const insertSalt = v1.prepare("INSERT INTO salts (day, salt) VALUES (?, ?)");
    oldSalts.forEach((salt, i) => insertSalt.run(`2025-${String(i).padStart(5, "0")}`, salt));
    v1.prepare("INSERT INTO apps (id, name, key_hash, created_at) VALUES ('a', 'a', 'h', 1)").run();
    insertSalt.run("2026-10-18", current);
    v1.prepare("DELETE FROM salts WHERE day < ?").run("2026-10-18");
    v1.close();

    const files = () => [path, `${path}-wal`].filter(existsSync).map((p) => readFileSync(p));
    const onDisk = (salt: Buffer) => files().some((f) => f.includes(salt));
    // Precondition: without secure_delete the deleted salts really are still on disk.
    expect(oldSalts.filter(onDisk).length).toBeGreaterThan(0);
    expect(onDisk(current)).toBe(true);

    store = openStore(path);
    const tables = new DatabaseSync(path, { readOnly: true });
    expect(tables.prepare("SELECT name FROM sqlite_master WHERE name = 'salts'").all()).toEqual([]);
    expect(tables.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    tables.close();
    expect(store.appByName("a")?.id).toBe("a");
    expect(oldSalts.filter(onDisk)).toHaveLength(0);
    expect(onDisk(current)).toBe(false);
  });

  it("migration 3 upgrades a version 2 database with events in place", () => {
    store.close();
    const path = join(dir, "v2.db");
    const v2 = new DatabaseSync(path);
    v2.exec(MIGRATIONS[0]!);
    v2.exec(MIGRATIONS[1]!);
    v2.exec("PRAGMA user_version = 2");
    v2.prepare("INSERT INTO apps (id, name, key_hash, created_at) VALUES ('a', 'a', 'h', 1)").run();
    v2.prepare(`INSERT INTO events (app_id, event_id, ts, received_at, client_ts, type, release, environment)
                VALUES ('a', 'e1', 1, 1, 1, 'lifecycle', 'r', 'test')`).run();
    v2.close();

    store = openStore(path);
    expect(store.recentEvents("a")).toMatchObject([{ event_id: "e1", parent_id: null }]);
    expect(store.openFindings("a")).toEqual([]);
    expect(store.missingHours("a", 0, 3_600_000)).toEqual([0]);
  });

  it("migration 9 keeps an app that was red red: open criticals start their streak from their hits", () => {
    store.close();
    const path = join(dir, "v8.db");
    const v8 = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 8)) v8.exec(m);
    v8.exec("PRAGMA user_version = 8");
    v8.prepare("INSERT INTO apps (id, name, key_hash, created_at) VALUES ('a', 'a', 'h', 1)").run();
    const add = v8.prepare(`INSERT INTO findings (app_id, agent, fingerprint, signal, severity, state, summary, action, evidence, hits, misses, first_seen, last_seen)
                            VALUES ('a', 'health', ?, 's', ?, ?, 'x', 'y', '{}', ?, 0, 1, 1)`);
    add.run("health:s:red", "critical", "open", 4);
    add.run("health:s:warn", "warning", "open", 4);
    add.run("health:s:old", "critical", "resolved", 4);
    v8.close();
    store = openStore(path);
    const streaks = Object.fromEntries(store.findingHistory("a").map((f) => [f.fingerprint, f.critical_streak]));
    expect(streaks).toEqual({ "health:s:red": 4, "health:s:warn": 0, "health:s:old": 0 });
    expect(store.appStatus("a", { now: 1, freshMs: Infinity }).status).toBe("red");
  });

  it("reopening an existing database does not re-run migrations or lose data", () => {
    const { app } = store.createApp("a", "test");
    store.insertBatch(app.id, batch([request()]));
    store.close();
    store = openStore(join(dir, "test.db"));
    expect(store.countEvents(app.id)).toBe(1);
  });
});

describe("profiles (DECISIONS #119)", () => {
  const profile = (ts: number, o: { route?: string; kind?: "cpu" | "block" | "heap"; event_id?: string } = {}): { event: AbigaailEvent; derived: { ts: number } } => ({
    event: {
      type: "profile", event_id: o.event_id ?? id(), client_ts: 1, kind: o.kind ?? "cpu", window_ms: 10_000, samples: 100,
      frames: [{ file: "src/a.ts", line: 3, fn: "a" }, { file: "(node)", line: 0 }], stacks: [{ frames: [1, 0], weight: 100 }],
      ...(o.route ? { route: o.route } : {}),
    },
    derived: { ts },
  });
  const put = (appId: string, events: ReturnType<typeof profile>[]) =>
    store.insertBatch(appId, { receivedAt: t, release: "r1", environment: "test", events });

  it("go to their own table, are idempotent, never become events or live rows, and read back per app and route", () => {
    const a = store.createApp("a", "test").app.id;
    const b = store.createApp("b", "test").app.id;
    const same = id();
    const res = put(a, [profile(100, { event_id: same }), profile(200, { route: "/x" }), profile(300, { kind: "heap" })]);
    expect(res).toMatchObject({ inserted: 3, duplicates: 0, rows: [] });
    expect(put(a, [profile(100, { event_id: same })])).toMatchObject({ inserted: 0, duplicates: 1 });
    put(b, [profile(150)]);
    expect(raw<{ n: number }>("SELECT count(*) AS n FROM events")[0]!.n).toBe(0);
    expect(store.profiles(a, "cpu", 0, 1000, 10).map((p) => p.ts)).toEqual([200, 100]);
    expect(store.profiles(a, "cpu", 0, 1000, 10, null).map((p) => p.ts)).toEqual([100]);
    expect(store.profiles(a, "cpu", 0, 1000, 10, "/x")[0]).toMatchObject({ route: "/x", frames: [{ file: "src/a.ts", line: 3, fn: "a" }, { file: "(node)", line: 0 }], stacks: [{ frames: [1, 0], weight: 100 }] });
    expect(store.profiles(b, "cpu", 0, 1000, 10)).toHaveLength(1);
  });

  it("expire per app, in bounded batches", () => {
    const a = store.createApp("a", "test").app.id;
    put(a, [profile(100), profile(200), profile(300)]);
    expect(store.retentionScopes("profiles")).toEqual([a]);
    expect(store.deleteExpired("profiles", a, 250, 1)).toBe(1);
    expect(store.deleteExpired("profiles", a, 250, 10)).toBe(1);
    expect(store.profiles(a, "cpu", 0, 1000, 10).map((p) => p.ts)).toEqual([300]);
  });
});
