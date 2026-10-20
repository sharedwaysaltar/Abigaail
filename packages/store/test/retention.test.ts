// Retention at the store level (DECISIONS #88, #89): what each delete removes
// and keeps, that baselines never lose a rolled hour, that every delete is
// scoped by app_id, and the one-time incremental-vacuum conversion.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR_MS, openStore, type Store } from "@abigaail/store";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
let dir: string;
let path: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-retention-"));
  path = join(dir, "test.db");
  store = openStore(path, { now: () => NOW });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** `count` human requests spread over the hour starting at `hour`. */
function requests(appId: string, hour: number, count: number, release = "r1", visitors = 5): void {
  store.insertBatch(appId, {
    receivedAt: hour + HOUR_MS - 1,
    release,
    environment: "test",
    events: Array.from({ length: count }, (_, i) => {
      const ts = hour + Math.floor((HOUR_MS * i) / count);
      return {
        event: { type: "request" as const, event_id: id(), client_ts: ts, method: "GET" as const, route: "/", status: 200, duration_ms: 10 },
        derived: { ts, bot_class: "human" as const, visitor_hash: `v${i % visitors}`, browser: null },
      };
    }),
  });
}

const raw = <T>(sql: string, ...params: (string | number)[]): T[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

describe("scopes", () => {
  it("covers every app_id with rows: active, disabled and ones with no apps row", () => {
    const a = store.createApp("a", "test").app.id;
    const b = store.createApp("b", "test").app.id;
    requests(a, NOW - 40 * DAY, 2);
    requests(b, NOW - 40 * DAY, 2);
    store.disableApp("b", "test");
    store.addIngestRejections([{ app_id: "ghost", minute: 0, status: 403, n: 1 }, { app_id: "", minute: 0, status: 401, n: 1 }]);
    expect(store.retentionScopes("events").sort()).toEqual([a, b].sort());
    expect(store.retentionScopes("ingest_rejections")).toEqual(["", "ghost"]);
    expect(() => store.retentionScopes("apps" as never)).toThrow(RangeError);
  });
});

describe("raw events", () => {
  it("rolls an hour up before deleting it, deletes whole hours before the cutoff only, in bounded batches", () => {
    const a = store.createApp("a", "test").app.id;
    const old = Math.floor((NOW - 40 * DAY) / HOUR_MS) * HOUR_MS;
    const cutoff = old + 2 * HOUR_MS;
    requests(a, old, 30);
    requests(a, old + HOUR_MS, 20);
    requests(a, cutoff, 10);
    // Nothing is rolled up yet: the first batch must roll the oldest hour first.
    const first = store.deleteOldEvents(a, cutoff, 25);
    expect(first).toEqual({ deleted: 25, rolled: true, more: true });
    expect(raw("SELECT hour, events FROM rollup_hours WHERE app_id = ? ORDER BY hour", a)).toEqual([{ hour: old, events: 30 }]);
    expect(store.hourly(a, "route", [old], "/")[0]).toMatchObject({ n: 30 });

    expect(store.deleteOldEvents(a, cutoff, 25)).toMatchObject({ deleted: 5, rolled: false, more: true });
    expect(store.deleteOldEvents(a, cutoff, 25)).toEqual({ deleted: 20, rolled: true, more: false });
    expect(store.deleteOldEvents(a, cutoff, 25)).toEqual({ deleted: 0, rolled: false, more: false });
    // The hour at the cutoff stays, and both old hours are in the rollup.
    expect(store.countEvents(a)).toBe(10);
    expect(store.oldestEventTs(a)).toBe(cutoff);
    expect(store.rolledHours(a, [old, old + HOUR_MS])).toEqual(new Map([[old, 30], [old + HOUR_MS, 20]]));
    expect(() => store.deleteOldEvents(a, cutoff + 1, 10)).toThrow(/hour/);
  });

  it("never touches another app's events", () => {
    const a = store.createApp("a", "test").app.id;
    const b = store.createApp("b", "test").app.id;
    const old = Math.floor((NOW - 40 * DAY) / HOUR_MS) * HOUR_MS;
    requests(a, old, 10);
    requests(b, old, 10);
    while (store.deleteOldEvents(a, old + HOUR_MS, 3).deleted);
    expect(store.countEvents(a)).toBe(0);
    expect(store.countEvents(b)).toBe(10);
    expect(store.rolledHours(b, [old]).size).toBe(0);
  });
});

describe("baselines never lose a rolled hour", () => {
  it("re-rolling an hour whose raw events were deleted keeps its stats (fails without the rollupHour guard)", () => {
    const a = store.createApp("a", "test").app.id;
    const hour = Math.floor((NOW - 40 * DAY) / HOUR_MS) * HOUR_MS;
    requests(a, hour, 40);
    store.rollupHour(a, hour);
    const stats = store.hourly(a, "route", [hour]);
    const uniques = store.dailyUniques(a, [new Date(hour).toISOString().slice(0, 10)]);
    while (store.deleteOldEvents(a, hour + HOUR_MS, 1000).deleted);

    expect(store.rollupHour(a, hour)).toBe(false);
    expect(store.hourly(a, "route", [hour])).toEqual(stats);
    expect(store.rolledHours(a, [hour])).toEqual(new Map([[hour, 40]]));
    expect(store.dailyUniques(a, [new Date(hour).toISOString().slice(0, 10)])).toEqual(uniques);
  });

  it("a day's unique humans never shrink when part of the day's raw events is gone", () => {
    const a = store.createApp("a", "test").app.id;
    const day = Math.floor((NOW - 40 * DAY) / DAY) * DAY;
    requests(a, day, 10, "r1", 10);
    requests(a, day + HOUR_MS, 10, "r1", 3);
    store.rollupHour(a, day);
    const key = new Date(day).toISOString().slice(0, 10);
    expect(store.dailyUniques(a, [key]).get(key)).toBe(10);
    while (store.deleteOldEvents(a, day + HOUR_MS, 1000).deleted);
    // Rolling the day's next hour sees only 3 visitors left, but the day keeps 10.
    expect(store.rollupHour(a, day + HOUR_MS)).toBe(true);
    expect(store.dailyUniques(a, [key]).get(key)).toBe(10);
  });

  it("deletes rollup_hours and their stats together, only before the cutoff", () => {
    const a = store.createApp("a", "test").app.id;
    const old = Math.floor((NOW - 500 * DAY) / HOUR_MS) * HOUR_MS;
    for (let h = 0; h < 10; h++) {
      requests(a, old + h * HOUR_MS, 2);
      store.rollupHour(a, old + h * HOUR_MS);
    }
    const cutoff = old + 7 * HOUR_MS;
    expect(store.deleteOldRollups(a, cutoff, 4)).toBeGreaterThan(0);
    // Each batch removes both tables' rows for the same hours.
    const marks = raw<{ hour: number }>("SELECT hour FROM rollup_hours WHERE app_id = ? ORDER BY hour", a).map((r) => r.hour);
    const stats = [...new Set(raw<{ hour: number }>("SELECT hour FROM hourly_route_stats WHERE app_id = ? ORDER BY hour", a).map((r) => r.hour))];
    expect(marks).toEqual(stats);
    expect(marks[0]).toBe(old + 4 * HOUR_MS);
    while (store.deleteOldRollups(a, cutoff, 4));
    expect(raw("SELECT hour FROM rollup_hours WHERE app_id = ? ORDER BY hour", a)).toEqual(
      [7, 8, 9].map((h) => ({ hour: old + h * HOUR_MS })),
    );
  });
});

describe("other tables", () => {
  it("findings: only resolved ones expire, per app and for Abigaail itself", () => {
    const a = store.createApp("a", "test").app.id;
    const finding = (app_id: string | null, fp: string) => ({
      app_id, agent: "health", fingerprint: fp, signal: "s", severity: "warning" as const, summary: "x", action: "y", evidence: {},
    });
    const runAt = (t: number, fs: ReturnType<typeof finding>[], evaluated: (string | null)[]) =>
      store.recordRun({ agent: "health", started_at: t, finished_at: t, outcome: "ok", apps_ok: 1, apps_failed: 0 }, fs, evaluated);
    const old = NOW - 400 * DAY;
    runAt(old, [finding(a, "health:old:"), finding(null, "health:sys:"), finding(a, "health:open:")], [a, null]);
    // Resolve the first two (3 misses), keep the third open by emitting it.
    for (let i = 1; i <= 3; i++) runAt(old + i, [finding(a, "health:open:")], [a, null]);
    expect(store.deleteExpired("findings", a, NOW - 180 * DAY, 100)).toBe(1);
    expect(store.deleteExpired("findings", null, NOW - 180 * DAY, 100)).toBe(1);
    expect(store.openFindings(a).map((f) => f.fingerprint)).toEqual(["health:open:"]);
    expect(raw("SELECT count(*) AS n FROM findings")).toEqual([{ n: 1 }]);
  });

  it("agent runs: old runs go, but each agent's newest ok run is kept", () => {
    const run = (agent: string, t: number, outcome: "ok" | "error") =>
      store.recordRun({ agent, started_at: t, finished_at: t, outcome, apps_ok: 0, apps_failed: 0 }, [], []);
    run("usage", NOW - 90 * DAY, "ok");
    run("usage", NOW - 80 * DAY, "ok");
    run("usage", NOW - 70 * DAY, "error");
    run("health", NOW - 60 * DAY, "error");
    run("health", NOW - DAY, "ok");
    expect(store.deleteExpired("agent_runs", null, NOW - 30 * DAY, 100)).toBe(3);
    expect(raw("SELECT agent, finished_at FROM agent_runs ORDER BY id")).toEqual([
      { agent: "usage", finished_at: NOW - 80 * DAY },
      { agent: "health", finished_at: NOW - DAY },
    ]);
    expect(store.lastOkRun("usage")).toBe(NOW - 80 * DAY);
  });

  it("rejections, size samples, audit entries and daily uniques expire by their own time column", () => {
    const a = store.createApp("a", "test").app.id; // writes an audit entry at NOW
    store.addIngestRejections([
      { app_id: a, minute: NOW - 40 * DAY, status: 429, n: 3 },
      { app_id: a, minute: NOW - 40 * DAY, status: 403, n: 1 },
      { app_id: a, minute: NOW - DAY, status: 429, n: 1 },
      { app_id: "", minute: NOW - 40 * DAY, status: 401, n: 9 },
    ]);
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO db_size_samples (ts, bytes) VALUES (?, 1), (?, 2)").run(NOW - 100 * DAY, NOW - DAY);
    db.prepare("INSERT INTO audit_log (ts, actor, action, app_id) VALUES (?, 'cli', 'x', ?), (?, 'cli', 'y', NULL)").run(NOW - 500 * DAY, a, NOW - 500 * DAY);
    db.prepare("INSERT INTO daily_uniques (app_id, day, humans) VALUES (?, '2025-01-01', 4), (?, '2026-10-19', 5)").run(a, a);
    db.close();

    expect(store.deleteExpired("ingest_rejections", a, NOW - 30 * DAY, 100)).toBe(2);
    expect(store.deleteExpired("ingest_rejections", "", NOW - 30 * DAY, 100)).toBe(1);
    expect(store.deleteExpired("db_size_samples", null, NOW - 90 * DAY, 100)).toBe(1);
    expect(store.deleteExpired("audit_log", a, NOW - 400 * DAY, 100)).toBe(1);
    expect(store.deleteExpired("audit_log", null, NOW - 400 * DAY, 100)).toBe(1);
    expect(store.deleteExpired("daily_uniques", a, "2025-11-15", 100)).toBe(1);
    expect(raw("SELECT count(*) AS n FROM ingest_rejections")).toEqual([{ n: 1 }]);
    expect(raw("SELECT action FROM audit_log")).toEqual([{ action: "app.create" }]);
    expect(store.dailyUniques(a, ["2025-01-01", "2026-10-19"])).toEqual(new Map([["2026-10-19", 5]]));
    expect(() => store.deleteExpired("agent_runs", a, 0, 1)).toThrow(RangeError);
  });

  it("batches stop at the limit", () => {
    const a = store.createApp("a", "test").app.id;
    store.addIngestRejections(Array.from({ length: 10 }, (_, i) => ({ app_id: a, minute: i * 60_000, status: 429, n: 1 })));
    expect(store.deleteExpired("ingest_rejections", a, NOW, 4)).toBe(4);
    expect(store.deleteExpired("ingest_rejections", a, NOW, 4)).toBe(4);
    expect(store.deleteExpired("ingest_rejections", a, NOW, 4)).toBe(2);
  });

  it("records the policy for the dashboard, keeping the last run on update", () => {
    store.writeRetentionPolicy([{ name: "events", keep_days: 30, min_days: 7 }]);
    store.recordRetention(NOW, { events: 12 });
    store.writeRetentionPolicy([{ name: "events", keep_days: 14, min_days: 7 }]);
    expect(store.retentionPolicy()).toEqual([
      { name: "events", keep_days: 14, min_days: 7, updated_at: NOW, last_run_at: NOW, last_deleted: 12 },
    ]);
  });
});

describe("every retention delete is scoped by app_id", () => {
  const APP_TABLES = ["events", "findings", "hourly_route_stats", "rollup_hours", "daily_uniques", "deploys", "ingest_rejections", "audit_log"];
  const src = readFileSync(fileURLToPath(new URL("../src/store.ts", import.meta.url)), "utf8");
  const deletes = [...src.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .filter((q) => /\bDELETE\s+FROM\s+\w+/i.test(q));

  it("finds the deletes", () => {
    expect(deletes.length).toBeGreaterThan(10);
  });

  it.each(deletes.map((q) => [q.replace(/\s+/g, " ").trim().slice(0, 90), q]))("%s", (_label, q) => {
    const table = /\bDELETE\s+FROM\s+(\w+)/i.exec(q)![1]!;
    if (!APP_TABLES.includes(table)) return;
    // Rows without an app (Abigaail's own findings and audit entries) are their own scope.
    expect(q).toMatch(new RegExp(`DELETE FROM ${table} WHERE app_id (= \\?|IS NULL)`));
  });
});

describe("incremental vacuum", () => {
  /** A database file made before chunk 7: auto_vacuum off. */
  function legacy(): void {
    store.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA auto_vacuum = NONE; VACUUM;");
    db.close();
    store = openStore(path, { now: () => NOW });
  }

  it("new files are incremental from the start", () => {
    expect(store.autoVacuum()).toBe(2);
    expect(store.convertToIncremental()).toEqual({ status: "already" });
  });

  it("converts an existing file when there is room, and freed pages then leave the file", () => {
    legacy();
    expect(store.autoVacuum()).toBe(0);
    const a = store.createApp("a", "test").app.id;
    const old = Math.floor((NOW - 40 * DAY) / HOUR_MS) * HOUR_MS;
    for (let h = 0; h < 4; h++) requests(a, old + h * HOUR_MS, 500);
    const result = store.convertToIncremental();
    expect(result.status).toBe("converted");
    expect(store.autoVacuum()).toBe(2);
    while (store.deleteOldEvents(a, old + 4 * HOUR_MS, 1000).deleted);
    expect(store.freePages()).toBeGreaterThan(0);
    while (store.incrementalVacuum(10) > 0);
    expect(store.freePages()).toBe(0);
    // The process-wide temp directory is reset afterwards.
    expect(JSON.stringify(raw("PRAGMA temp_store_directory"))).not.toContain(dir);
  });

  it("skips the conversion without enough free disk and keeps working", () => {
    legacy();
    const a = store.createApp("a", "test").app.id;
    const old = Math.floor((NOW - 40 * DAY) / HOUR_MS) * HOUR_MS;
    requests(a, old, 200);
    const result = store.convertToIncremental({ freeBytes: () => 1000 });
    expect(result).toMatchObject({ status: "no_space", freeBytes: 1000 });
    expect(result.status === "no_space" && result.needBytes).toBeGreaterThan(2 * store.dbBytes());
    expect(store.autoVacuum()).toBe(0);
    // Deletion still works; there are just no pages to return.
    while (store.deleteOldEvents(a, old + HOUR_MS, 1000).deleted);
    expect(store.countEvents(a)).toBe(0);
    expect(store.incrementalVacuum(100)).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("puts VACUUM's temp file in the database's directory, never /tmp or /var/tmp", async () => {
    legacy();
    const a = store.createApp("a", "test").app.id;
    for (let h = 0; h < 40; h++) requests(a, NOW - 40 * DAY + h * HOUR_MS, 500);
    // A worker watches this process's open files while the main thread is blocked in VACUUM.
    const watcher = new Worker(
      `const { readdirSync, readlinkSync } = require("node:fs");
       const { parentPort } = require("node:worker_threads");
       const seen = new Set(); let stop = false;
       parentPort.on("message", () => { stop = true; parentPort.postMessage([...seen]); });
       (function poll() {
         for (const f of readdirSync("/proc/self/fd")) { try { seen.add(readlinkSync("/proc/self/fd/" + f)); } catch {} }
         if (!stop) setImmediate(poll);
       })();
       parentPort.postMessage("ready");`,
      { eval: true },
    );
    await new Promise((resolve) => watcher.once("message", resolve));
    expect(store.convertToIncremental().status).toBe("converted");
    watcher.postMessage("stop");
    const seen = (await new Promise((resolve) => watcher.once("message", resolve))) as string[];
    await watcher.terminate();
    const temp = seen.filter((f) => /etilqs_/.test(f));
    expect(temp.length).toBeGreaterThan(0);
    for (const f of temp) expect(f.startsWith(dir)).toBe(true);
    // Nothing is left behind in the directory.
    expect(readdirSync(dir).filter((f) => f.startsWith("etilqs_"))).toEqual([]);
  });
});
