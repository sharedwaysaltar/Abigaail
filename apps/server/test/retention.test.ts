// The retention job (DECISIONS #87-#90): periods from the environment, what a
// run deletes and keeps, that baselines are unchanged at the minimums, that
// deleted bytes are gone from the files, that it never blocks ingest, catches
// up in 5-minute runs, and fails loudly when the WAL cannot be truncated.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineSlots, BASELINE, rowsByKey } from "@abigaail/insights";
import { hourCutoff, loadConfig, loadRetention, nextRunAt, Retention, thresholds, type RetentionOptions } from "@abigaail/server";
import { HOUR_MS, openAuthStore, openStore, type Store } from "@abigaail/store";

const { RETENTION } = thresholds;
const MIN = 60_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Tuesday 2026-10-20 14:20 UTC. */
const T0 = Date.UTC(2026, 9, 20, 14, 20, 0);

let dir: string;
let path: string;
let authPath: string;
let now: number;
let store: Store;
let retention: Retention | undefined;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-retention-job-"));
  path = join(dir, "abigaail.db");
  authPath = join(dir, "auth.db");
  now = T0;
  store = openStore(path, { now: () => now });
  logs = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await retention?.stop();
  retention = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const defaults = () => loadRetention({});
const minimums = () =>
  Object.fromEntries(Object.entries(RETENTION.periods).map(([k, p]) => [k, p.minDays])) as ReturnType<typeof loadRetention>;

function job(opts: Partial<RetentionOptions> = {}): Retention {
  retention = new Retention({ store, days: defaults(), authDbPath: authPath, now: () => now, log: (m) => logs.push(m), ...opts });
  return retention;
}

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** `count` human requests over the hour starting at `hour`. */
function requests(appId: string, hour: number, count: number, release = "r1", visitor = "v"): void {
  for (let i = 0; i < count; i += 500) {
    const slice = Array.from({ length: Math.min(500, count - i) }, (_, j) => {
      const ts = hour + Math.floor((HOUR_MS * (i + j)) / count);
      return {
        event: { type: "request" as const, event_id: id(), client_ts: ts, method: "GET" as const, route: "/", status: 200, duration_ms: 10 + ((i + j) % 7) },
        derived: { ts, bot_class: "human" as const, visitor_hash: `${visitor}${(i + j) % 9}`, browser: null },
      };
    });
    store.insertBatch(appId, { receivedAt: hour + HOUR_MS - 1, release, environment: "test", events: slice });
  }
}

const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
const runs = () => store.recentRuns("retention", 100);

describe("periods from the environment", () => {
  it("defaults, and the minimums baselines need", () => {
    expect(defaults()).toEqual({
      events: 30, rollups: 400, daily_uniques: 400, findings: 180, agent_runs: 30, ingest_rejections: 30, db_size_samples: 90, audit_log: 400,
    });
    // Baselines read the same hour-of-week over BASELINE.weeks; one more week covers the week judged.
    expect(RETENTION.periods.rollups.minDays).toBe((BASELINE.weeks + 1) * 7);
    expect(RETENTION.periods.daily_uniques.minDays).toBe((BASELINE.weeks + 1) * 7);
    // Raw events outlive ingest's 24 h late window, so a deleted hour never gets new events.
    expect(RETENTION.periods.events.minDays).toBeGreaterThan(1);
  });

  it("accepts whole days within the limits", () => {
    expect(loadRetention({ ABIGAAIL_RETAIN_EVENTS_DAYS: " 14 ", ABIGAAIL_RETAIN_AUDIT_DAYS: "3650" })).toMatchObject({ events: 14, audit_log: 3650 });
    expect(loadRetention({ ABIGAAIL_RETAIN_EVENTS_DAYS: "" }).events).toBe(30);
  });

  it.each([
    ["ABIGAAIL_RETAIN_EVENTS_DAYS", "6", /below the minimum of 7 days/],
    ["ABIGAAIL_RETAIN_ROLLUPS_DAYS", "34", /below the minimum of 35 days/],
    ["ABIGAAIL_RETAIN_EVENTS_DAYS", "7.5", /whole number of days/],
    ["ABIGAAIL_RETAIN_EVENTS_DAYS", "-7", /whole number of days/],
    ["ABIGAAIL_RETAIN_FINDINGS_DAYS", "forever", /whole number of days/],
    ["ABIGAAIL_RETAIN_AUDIT_DAYS", "3651", /above the maximum of 3650 days/],
  ])("%s=%s stops the server", (key, value, message) => {
    expect(() => loadRetention({ [key]: value })).toThrow(message);
    expect(() => loadConfig({ [key]: value })).toThrow(message);
  });
});

describe("a run", () => {
  it("deletes what is past its period in every table and scope, keeps the rest, and records itself", async () => {
    const a = store.createApp("a", "test").app.id;
    const b = store.createApp("b", "test").app.id;
    const oldHour = hourOf(T0 - 31 * DAY);
    const keepHour = hourOf(T0 - 29 * DAY);
    requests(a, oldHour, 20);
    requests(a, keepHour, 5);
    requests(b, oldHour, 20);
    store.disableApp("b", "test");
    // Rollups and uniques from long ago, rejections for an app_id with no apps row.
    now = T0 - 500 * DAY;
    store.rollupHour(a, hourOf(now));
    now = T0;
    store.addIngestRejections([{ app_id: "ghost", minute: T0 - 40 * DAY, status: 403, n: 2 }, { app_id: "ghost", minute: T0 - MIN, status: 403, n: 1 }]);
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO db_size_samples (ts, bytes) VALUES (?, 1), (?, 2)").run(T0 - 100 * DAY, T0 - HOUR_MS);
    db.close();

    const report = await job().runOnce();
    expect(report).toMatchObject({ outcome: "ok", behind: false });
    for (const app of [a, b]) expect((store.oldestEventTs(app) ?? Infinity) >= hourCutoff(T0, 30)).toBe(true);
    expect(store.countEvents(a)).toBe(5);
    expect(store.countEvents(b)).toBe(0);
    // The deleted hour was rolled up first, for both apps; the 500-day-old one is gone.
    expect(store.rolledHours(a, [oldHour]).get(oldHour)).toBe(20);
    expect(store.rolledHours(b, [oldHour]).get(oldHour)).toBe(20);
    expect(store.rolledHours(a, [hourOf(T0 - 500 * DAY)]).size).toBe(0);
    expect(store.ingestRejections("ghost", 0)).toEqual([{ status: 403, n: 1 }]);
    expect(store.dbSizeSamples(0).map((s) => s.bytes)).toEqual([2]);

    expect(report.deleted).toMatchObject({ events: 40, ingest_rejections: 1, db_size_samples: 1 });
    expect(runs()).toMatchObject([{ agent: "retention", outcome: "ok", started_at: T0 }]);
    const policy = new Map(store.retentionPolicy().map((p) => [p.name, p]));
    expect(policy.get("events")).toMatchObject({ keep_days: 30, min_days: 7, last_run_at: T0, last_deleted: 40 });
    expect(policy.get("rollups")).toMatchObject({ keep_days: 400, min_days: 35 });
    expect(policy.get("sessions")).toMatchObject({ keep_days: 0 });
  });

  it("leaves baselines and the uniques comparison unchanged with every period at its minimum", async () => {
    const a = store.createApp("a", "test").app.id;
    const hour = hourOf(T0);
    // Six weeks of the same hour-of-week, plus each of the last 7 days, rolled as the runner would.
    for (let k = 1; k <= 6; k++) {
      requests(a, hour - k * WEEK, 30 + k);
      store.rollupHour(a, hour - k * WEEK);
    }
    for (let d = 1; d <= 7; d++) {
      requests(a, hour - d * DAY, 20 + d);
      store.rollupHour(a, hour - d * DAY);
    }
    const before = rowsByKey(store, a, "route", baselineSlots(store, a, hour));
    const days = [1, 8, 15, 22, 29].map((d) => new Date(hourOf(T0) - d * DAY).toISOString().slice(0, 10));
    const uniques = store.dailyUniques(a, days);

    await job({ days: minimums() }).runOnce();
    expect(store.oldestEventTs(a)! >= hourCutoff(T0, 7)).toBe(true);
    expect(rowsByKey(store, a, "route", baselineSlots(store, a, hour))).toEqual(before);
    expect(baselineSlots(store, a, hour).source).toBe("hour-of-week");
    expect(store.dailyUniques(a, days)).toEqual(uniques);
    // Week 6 is past the 35-day minimum and goes; weeks 1-4 (the baseline) stay.
    expect(store.rolledHours(a, [hour - 6 * WEEK]).size).toBe(0);
    expect(store.rolledHours(a, [1, 2, 3, 4].map((k) => hour - k * WEEK)).size).toBe(4);
  });

  it("keeps open findings and each agent's newest ok run at any age", async () => {
    const a = store.createApp("a", "test").app.id;
    const finding = { app_id: a, agent: "health", fingerprint: "health:x:", signal: "x", severity: "warning" as const, summary: "s", action: "a", evidence: {} };
    store.recordRun({ agent: "health", started_at: T0 - 300 * DAY, finished_at: T0 - 300 * DAY, outcome: "ok", apps_ok: 1, apps_failed: 0 }, [finding], [a]);
    await job().runOnce();
    expect(store.openFindings(a).map((f) => f.fingerprint)).toEqual(["health:x:"]);
    expect(store.lastOkRun("health")).toBe(T0 - 300 * DAY);
  });
});

describe("deleted bytes are gone from the files", () => {
  const marker = (s: string) => `zz${s}q9`;
  const files = (p: string) => [p, `${p}-wal`].filter(existsSync).map((f) => readFileSync(f));
  const onDisk = (p: string, m: string) => files(p).some((f) => f.includes(m));

  /** Old rows with markers in the monitoring and auth databases, plus rows that must stay. */
  function seed(): { a: string } {
    const a = store.createApp("a", "test").app.id;
    // The visitor hash is the pseudonymous field, and only raw events hold it.
    requests(a, hourOf(T0 - 40 * DAY), 300, "r1", marker("oldvisitor"));
    requests(a, hourOf(T0 - HOUR_MS), 5, "r1", marker("keepvisitor"));
    const f = { app_id: a, agent: "health", fingerprint: "health:old:", signal: "old", severity: "warning" as const, summary: marker("oldsummary"), action: "a", evidence: {} };
    const at = T0 - 200 * DAY;
    store.recordRun({ agent: "health", started_at: at, finished_at: at, outcome: "ok", apps_ok: 1, apps_failed: 0 }, [f], [a]);
    for (let i = 1; i <= 3; i++) store.recordRun({ agent: "health", started_at: at + i, finished_at: at + i, outcome: "ok", apps_ok: 1, apps_failed: 0 }, [], [a]);
    const auth = openAuthStore(authPath, { now: () => T0 - 13 * HOUR_MS });
    auth.createSession(marker("oldsession"), auth.createUser("owner", "h", "s", "cli").id);
    auth.close();
    return { a };
  }

  it("after a run, no deleted marker is left in the database, its WAL, auth.db or its WAL", async () => {
    seed();
    expect(onDisk(path, marker("oldvisitor"))).toBe(true);
    const report = await job().runOnce();
    expect(report).toMatchObject({ outcome: "ok", deleted: { events: 300, findings: 1, sessions: 1 } });
    // While the server keeps the database open (closing it would checkpoint anyway).
    for (const m of ["oldvisitor", "oldsummary"]) expect(onDisk(path, marker(m))).toBe(false);
    store.close();
    for (const m of ["oldvisitor", "oldsummary"]) expect(onDisk(path, marker(m))).toBe(false);
    expect(onDisk(authPath, marker("oldsession"))).toBe(false);
    expect(onDisk(path, marker("keepvisitor"))).toBe(true);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare("PRAGMA freelist_count").get()).toEqual({ freelist_count: 0 });
    check.close();
    store = openStore(path, { now: () => now });
  });

  it("control: the same deletes without secure_delete and checkpoint leave the markers on disk", () => {
    seed();
    store.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA secure_delete = OFF");
    db.prepare("DELETE FROM events WHERE ts < ?").run(hourCutoff(T0, 30));
    db.exec("DELETE FROM findings");
    db.close(); // closing the last connection checkpoints, but without secure_delete the bytes stay in free pages
    expect(onDisk(path, marker("oldvisitor"))).toBe(true);
    expect(onDisk(path, marker("oldsummary"))).toBe(true);
    store = openStore(path, { now: () => now });
  });
});

describe("never blocking ingest", () => {
  it("deletes in transactions of at most batchRows, yields between them, and ingest gets in while it runs", async () => {
    const a = store.createApp("a", "test").app.id;
    requests(a, hourOf(T0 - 40 * DAY), 5000);
    const sizes: number[] = [];
    const del = store.deleteOldEvents.bind(store);
    store.deleteOldEvents = (appId, before, limit) => {
      const r = del(appId, before, limit);
      sizes.push(r.deleted);
      return r;
    };
    let finished = false;
    let insertedWhileRunning = false;
    const run = job({ batchRows: 400 }).runOnce().then((r) => {
      finished = true;
      return r;
    });
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        requests(a, hourOf(T0 - MIN), 1);
        insertedWhileRunning = !finished;
        resolve();
      }),
    );
    expect((await run).deleted.events).toBe(5000);
    expect(insertedWhileRunning).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(400);
    expect(sizes.filter((s) => s > 0).length).toBeGreaterThanOrEqual(13);
  });

  it("stops at its budget, reports work left, and the next runs finish the job", async () => {
    const a = store.createApp("a", "test").app.id;
    for (let h = 0; h < 6; h++) requests(a, hourOf(T0 - 40 * DAY) + h * HOUR_MS, 100);
    // Each clock reading is 1 ms of "work": every batch costs one.
    let tick = 0;
    const r = job({ batchRows: 50, budgetMs: 10, clock: () => tick++ });
    const first = await r.runOnce();
    expect(first).toMatchObject({ outcome: "ok", behind: true });
    // Recorded with the run, for the Watchdog (catching up vs deleting nothing).
    expect(store.runsSince("retention", 0)?.latestBehind).toBe(true);
    expect(first.deleted.events).toBeGreaterThan(0);
    expect(first.deleted.events).toBeLessThan(600);
    let total = first.deleted.events!;
    let last = first;
    for (let i = 0; i < 50 && last.behind; i++) {
      last = await r.runOnce();
      total += last.deleted.events!;
    }
    expect(last.behind).toBe(false);
    expect(store.runsSince("retention", 0)?.latestBehind).toBe(false);
    expect(total).toBe(600);
  });
});

describe("schedule", () => {
  it("next run at the next :30, or in 5 minutes while behind", () => {
    const h = Date.UTC(2026, 9, 20, 14, 0, 0);
    expect(nextRunAt(h + 10 * MIN, false)).toBe(h + 30 * MIN);
    expect(nextRunAt(h + 30 * MIN, false)).toBe(h + 90 * MIN);
    expect(nextRunAt(h + 45 * MIN, false)).toBe(h + 90 * MIN);
    expect(nextRunAt(h + 45 * MIN, true)).toBe(h + 50 * MIN);
  });

  it("runs every 5 minutes while behind, then hourly at :30 (fails if catch-up is removed)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: T0 });
    const a = store.createApp("a", "test").app.id;
    for (let h = 0; h < 30; h++) requests(a, hourOf(T0 - 40 * DAY) + h * HOUR_MS, 100);
    // Each clock reading is 1 ms of work: a run fits about a dozen batches.
    let tick = 0;
    const r = job({ now: () => Date.now(), batchRows: 100, budgetMs: 12, clock: () => tick++ });
    const reports: { behind: boolean; at: number }[] = [];
    const runOnce = r.runOnce.bind(r);
    r.runOnce = () => runOnce().then((rep) => (reports.push({ behind: rep.behind, at: Date.now() }), rep));
    const settle = async (count: number) => {
      for (let i = 0; i < 10_000 && reports.length < count; i++) await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    r.start();
    await settle(1);
    expect(reports[0]!.behind).toBe(true);
    const gaps: number[] = [];
    while (reports.length < 12) {
      const last = reports[reports.length - 1]!;
      const due = last.behind ? last.at + 5 * MIN : nextRunAt(last.at, false);
      vi.advanceTimersByTime(due - Date.now() - 1);
      await settle(reports.length + 1);
      expect(runs()).toHaveLength(reports.length); // not a millisecond early
      vi.advanceTimersByTime(1);
      await settle(reports.length + 1);
      expect(runs()[0]!.started_at).toBe(due);
      gaps.push(due - last.at);
    }
    // Catch-up runs every 5 minutes until the backlog is gone, then the hourly slot.
    const caughtUp = reports.findIndex((rep) => !rep.behind);
    expect(caughtUp).toBeGreaterThan(1);
    expect(gaps.slice(0, caughtUp).every((g) => g === 5 * MIN)).toBe(true);
    expect(gaps[caughtUp]).toBeGreaterThan(5 * MIN);
    expect(store.countEvents(a)).toBe(0);
  });
});

describe("failure is visible", () => {
  it("a reader holding an old snapshot makes the run an error (CheckpointBusy), and the next run recovers", async () => {
    const a = store.createApp("a", "test").app.id;
    requests(a, hourOf(T0 - 40 * DAY), 50);
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM events").get();
    const r = job({ checkpointRetryMs: 10 });
    const busy = await r.runOnce();
    expect(busy).toMatchObject({ outcome: "error", error_class: "CheckpointBusy", behind: true });
    expect(runs()[0]).toMatchObject({ outcome: "error", error_class: "CheckpointBusy" });
    reader.exec("COMMIT");
    reader.close();
    expect(await r.runOnce()).toMatchObject({ outcome: "ok", behind: false });
  });

  it("one table failing does not stop the others", async () => {
    const a = store.createApp("a", "test").app.id;
    requests(a, hourOf(T0 - 40 * DAY), 10);
    store.deleteExpired = () => {
      throw new TypeError("boom");
    };
    const report = await job().runOnce();
    expect(report).toMatchObject({ outcome: "error", error_class: "TypeError" });
    expect(store.countEvents(a)).toBe(0);
    expect(logs.some((l) => /retention: findings failed \(TypeError\)/.test(l))).toBe(true);
  });
});

describe("auth database", () => {
  it("deletes expired sessions and old audit entries, keeps live sessions", async () => {
    const auth = openAuthStore(authPath, { now: () => T0 - 500 * DAY });
    const user = auth.createUser("owner", "h", "s", "cli");
    auth.close();
    const live = openAuthStore(authPath, { now: () => T0 - MIN });
    live.createSession("live", user.id);
    live.close();
    const stale = openAuthStore(authPath, { now: () => T0 - 3 * HOUR_MS });
    stale.createSession("idle", user.id);
    stale.close();

    const report = await job().runOnce();
    expect(report.deleted.sessions).toBe(1);
    expect(report.deleted.audit_log).toBe(1);
    const after = openAuthStore(authPath);
    expect(after.sessionHashes()).toEqual(["live"]);
    expect(after.listAudit()).toEqual([]);
    after.close();
  });

  it("never creates auth.db", async () => {
    await job().runOnce();
    expect(existsSync(authPath)).toBe(false);
  });
});

describe("wiring", () => {
  it("main starts retention whether or not the agents are on", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(main).toMatch(/^const retention = new Retention\(/m);
    expect(main).toMatch(/^ {2}retention\.start\(\);/m);
    expect(main).toMatch(/void retention\.stop\(\)/);
  });
});
