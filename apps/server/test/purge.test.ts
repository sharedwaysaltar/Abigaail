// app:purge (DECISIONS #126): every row of the app goes and no other app's,
// the bytes are gone from the files, an enabled app or a mistyped name
// deletes nothing, an interrupted purge is finished by running it again,
// batches never hold the write lock between them, and a queued alert never
// carries a purged app.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Alerter, appNamedFingerprints, purgeApp, purgePlan, runPurgeCommand, vacuumIfOwed, type AlertMessage, type PurgeCommandDeps } from "@abigaail/server";
import { HOUR_MS, openStore, PURGE_DELETE, type App, type PurgeTable, type Store } from "@abigaail/store";
import { emit, recordingChannel } from "./alertfx.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);
let clock = T0;
let dir: string;
let path: string;
let store: Store;

beforeEach(() => {
  clock = T0;
  dir = mkdtempSync(join(tmpdir(), "abigaail-purge-"));
  path = join(dir, "abigaail.db");
  store = openStore(path, { now: () => clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const marker = (s: string) => `zz${s}q9`;
const hour = Math.floor(T0 / HOUR_MS) * HOUR_MS - HOUR_MS;

/** Rows of one app in every table app:purge empties, over a separate connection. */
function rows(appId: string): Record<PurgeTable, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(PURGE_DELETE.map((t) => [t, Number((db.prepare(`SELECT count(*) AS n FROM ${t} WHERE app_id = ?`).get(appId) as { n: number }).n)])) as Record<PurgeTable, number>;
  } finally {
    db.close();
  }
}

function sql<T>(q: string, ...params: (string | number | null)[]): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(q).all(...params) as T[];
  } finally {
    db.close();
  }
}

const finding = (app_id: string | null, fingerprint: string, summary: string, agent = "health") =>
  ({ app_id, agent, fingerprint, signal: "x", severity: "critical" as const, summary, action: "a", evidence: {} });

/** One app with a row in every table, `tag` planted in what it stores. */
function seed(name: string, tag: string): App {
  const app = store.createApp(name, "test").app;
  const events = Array.from({ length: 30 }, (_, i) => ({
    event: { type: "request" as const, event_id: id(), client_ts: hour + i * MIN, method: "GET" as const, route: `/${marker(`${tag}route`)}`, status: 500, duration_ms: 10 + i },
    derived: { ts: hour + i * MIN, bot_class: "human" as const, visitor_hash: marker(`${tag}visitor${i}`), browser: null },
  }));
  const profile = {
    event: { type: "profile" as const, event_id: id(), client_ts: hour, kind: "cpu" as const, window_ms: 10_000, samples: 10,
      frames: [{ file: "src/a.ts", line: 1, fn: marker(`${tag}fn`) }], stacks: [{ frames: [0], weight: 10 }] },
    derived: { ts: hour },
  };
  store.insertBatch(app.id, { receivedAt: hour + HOUR_MS - 1, release: marker(`${tag}release`), environment: "test", events: [...events, profile] });
  store.rollupHour(app.id, hour);
  emit(store, clock - 2 * MIN, app.id, [{ signal: "x", severity: "critical", summary: marker(`${tag}summary`) }]);
  emit(store, clock - MIN, app.id, [{ signal: "x", severity: "critical", summary: marker(`${tag}summary`) }]);
  store.addIngestRejections([{ app_id: app.id, minute: T0 - MIN, status: 429, n: 3 }]);
  store.addScrubMismatches([{ app_id: app.id, minute: T0 - MIN, n: 2 }]);
  return store.appByName(name)!;
}

/** Abigaail's own retention finding that names `name`, and its alert state. */
function systemFindingNaming(name: string): void {
  const fp = appNamedFingerprints(name)[0]!;
  store.recordRun({ agent: "watchdog", started_at: clock, finished_at: clock, outcome: "ok", apps_ok: 0, apps_failed: 0 }, [finding(null, fp, `Raw events of ${name} are kept too long`, "watchdog")], [null]);
  store.applyAlerts([{ app_id: null, fingerprint: fp, state: "firing", sent: null, finding_id: null, changed_at: clock, fired_at: null, fired_summary: null, flaps: 0 }], []);
}

/** One alerter sweep (and its sends) over the findings as they are now. */
async function sweepAlerts(): Promise<void> {
  const { channel } = recordingChannel("webhook");
  store.writeAlertChannels([{ channel: channel.name, label: channel.label }]);
  const alerter = new Alerter({ store, channels: [channel], now: () => clock, log: () => {} });
  alerter.sweep();
  await alerter.idle();
}

const files = () => [path, `${path}-wal`].filter(existsSync).map((f) => readFileSync(f));
const onDisk = (s: string) => files().some((f) => f.includes(s));
const occurrences = (s: string) => files().reduce((total, f) => {
  let k = 0;
  for (let i = f.indexOf(s); i >= 0; i = f.indexOf(s, i + 1)) k++;
  return total + k;
}, 0);

const purge = (app: App, o: Partial<Parameters<typeof purgeApp>[0]> = {}) => purgeApp({ store, app, pauseMs: 0, batchRows: 7, checkpointRetryMs: 1, ...o });

describe("what a purge deletes", () => {
  it("every row of the app in every table, its alert items, the system findings naming it, and the app; nothing of another app", async () => {
    const a = seed("shop", "a");
    const b = seed("blog", "b");
    systemFindingNaming("shop");
    systemFindingNaming("blog");
    await sweepAlerts();
    // A message that carried only shop, and one (the sweep above) that carried both.
    clock += MIN;
    emit(store, clock, a.id, [{ signal: "y", severity: "critical" }]);
    emit(store, clock + 1, a.id, [{ signal: "y", severity: "critical" }]);
    await sweepAlerts();
    for (const [t, count] of Object.entries(rows(a.id))) expect(count, t).toBeGreaterThan(0);
    const before = rows(b.id);
    const deliveries = sql<{ id: number; payload: string }>("SELECT id, payload FROM alert_deliveries ORDER BY id");
    expect(deliveries).toHaveLength(2);
    const plan = purgePlan(store, a);
    expect(plan).toMatchObject({ deliveries_deleted: 1, deliveries_rewritten: 1, system_rows: 2 });

    store.disableApp("shop", "cli");
    const done = await purge(a);

    expect(Object.values(rows(a.id)).every((count) => count === 0)).toBe(true);
    expect(store.appById(a.id)).toBeUndefined();
    expect(store.appByName("shop")).toBeUndefined();
    expect(rows(b.id)).toEqual(before);
    expect(store.appByName("blog")).toBeDefined();
    // The dry-run plan is what the purge deleted.
    expect(done).toEqual({ ...plan, resumed: 0 });
    // The mixed message stays, without shop; the shop-only one is gone.
    const left = sql<{ id: number; payload: string }>("SELECT id, payload FROM alert_deliveries ORDER BY id");
    expect(left.map((d) => d.id)).toEqual([deliveries[0]!.id]);
    const message = JSON.parse(left[0]!.payload) as AlertMessage;
    expect(message.items.map((i) => i.app)).toEqual(["blog"]);
    expect(message.more).toBe(0);
    // Abigaail's own finding about shop is gone; the one about blog stays.
    const system = store.systemFindings().map((f) => f.fingerprint);
    expect(system).toEqual([appNamedFingerprints("blog")[0]]);
    expect(store.alertStates(null).map((s) => s.fingerprint)).toEqual([appNamedFingerprints("blog")[0]]);
  });

  it("is audited with counts only: started (planned) and done (deleted), under the app's id", async () => {
    const a = seed("shop", "a");
    store.disableApp("shop", "cli");
    await purge(a);
    const audit = store.listAudit().filter((e) => e.app_id === a.id).map((e) => e.action);
    expect(audit).toEqual(["app.purge", "app.purge_started", "app.disable", "app.create"]);
    for (const e of store.listAudit().filter((x) => x.action.startsWith("app.purge"))) {
      expect(e.actor).toBe("cli");
      expect(e.detail).not.toContain("shop");
      const detail = JSON.parse(e.detail!) as { rows: Record<string, unknown> };
      for (const v of Object.values(detail.rows)) expect(typeof v).toBe("number");
    }
  });
});

describe("the bytes are gone", () => {
  const PLANTED = ["aroute", "avisitor1", "afn", "arelease", "asummary"];

  it("no planted value is left in the database or its WAL after the purge and the VACUUM at the next start; the app id only in its audit rows", async () => {
    const a = seed("shop", "a");
    seed("blog", "b");
    await sweepAlerts();
    for (const s of PLANTED) expect(onDisk(marker(s)), s).toBe(true);
    const before = PLANTED.reduce((k, s) => k + occurrences(marker(s)), 0);
    store.disableApp("shop", "cli");
    await purge(a);
    // The purge leaves the VACUUM owed. Until it runs, secure_delete has zeroed every deleted row; only a
    // few copies that page splits left in unused space of live pages may remain.
    expect(store.erasureOwedSince()).toBe(clock);
    const left = PLANTED.reduce((k, s) => k + occurrences(marker(s)), 0);
    expect(before).toBeGreaterThan(60);
    expect(left).toBeLessThanOrEqual(3);
    // The server restarts: the VACUUM runs before ingest listens.
    store.close();
    store = openStore(path, { now: () => clock });
    const logs: string[] = [];
    vacuumIfOwed(store, (m) => logs.push(m));
    expect(logs).toEqual([expect.stringMatching(/^database: VACUUM after app:purge in \d+ ms/)]);
    expect(store.erasureOwedSince()).toBeUndefined();
    // While the server keeps the database open.
    for (const s of PLANTED) expect(onDisk(marker(s)), s).toBe(false);
    expect(onDisk(marker("broute"))).toBe(true);
    const auditRows = sql<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE app_id = ?", a.id)[0]!.n;
    expect(auditRows).toBe(4);
    expect(occurrences(a.id)).toBe(auditRows);
    expect(sql("PRAGMA freelist_count")).toEqual([{ freelist_count: 0 }]);
    // Nothing owed: the next start does nothing.
    vacuumIfOwed(store, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
  });

  it("without room for the VACUUM it stays owed, and the next start tries again", async () => {
    const a = seed("shop", "a");
    store.disableApp("shop", "cli");
    await purge(a);
    const logs: string[] = [];
    vacuumIfOwed(store, (m) => logs.push(m), { freeBytes: () => 0 });
    expect(logs).toEqual([expect.stringMatching(/VACUUM after app:purge skipped: needs .* MB free, 0.0 MB free/)]);
    expect(store.erasureOwedSince()).toBe(clock);
    vacuumIfOwed(store, (m) => logs.push(m));
    expect(store.erasureOwedSince()).toBeUndefined();
  });
});

describe("safety", () => {
  function cli(answer: string) {
    const out: string[] = [];
    const asked: string[] = [];
    const deps: PurgeCommandDeps = {
      store,
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
      print: (line) => out.push(line),
      purge: { pauseMs: 0, checkpointRetryMs: 1 },
    };
    return { deps, out, asked };
  }

  it("refuses an enabled app: nothing deleted, nothing audited, no question asked", async () => {
    const a = seed("shop", "a");
    const before = rows(a.id);
    const { deps, out, asked } = cli("shop");
    expect(await runPurgeCommand(["shop"], deps)).toBe(1);
    expect(out.join("\n")).toMatch(/enabled\. Disable it first/);
    expect(asked).toEqual([]);
    expect(rows(a.id)).toEqual(before);
    expect(store.listAudit().map((e) => e.action)).toEqual(["app.create"]);
    // And the purge itself refuses, whoever calls it.
    await expect(purge(a)).rejects.toThrow(/not disabled/);
    expect(rows(a.id)).toEqual(before);
  });

  it("deletes nothing unless the name is typed again exactly", async () => {
    const a = seed("shop", "a");
    store.disableApp("shop", "cli");
    const before = rows(a.id);
    for (const typed of ["", "sho", "Shop", "blog"]) {
      const { deps, out, asked } = cli(typed);
      expect(await runPurgeCommand(["shop"], deps)).toBe(1);
      expect(asked).toHaveLength(1);
      expect(out.at(-1)).toBe("The name does not match; nothing was deleted.");
    }
    expect(rows(a.id)).toEqual(before);
    expect(store.listAudit().map((e) => e.action)).toEqual(["app.disable", "app.create"]);
    const { deps, out } = cli("shop");
    expect(await runPurgeCommand(["shop"], deps)).toBe(0);
    expect(out.at(-2)).toMatch(/^Purged "shop": \d+ rows deleted/);
    expect(out.at(-1)).toMatch(/^Restart the Abigaail server to finish/);
    expect(store.appByName("shop")).toBeUndefined();
  });

  it("--dry-run prints the counts per table and changes nothing (enabled or not, not audited)", async () => {
    const a = seed("shop", "a");
    const before = rows(a.id);
    const { deps, out, asked } = cli("shop");
    expect(await runPurgeCommand(["shop", "--dry-run"], deps)).toBe(0);
    expect(asked).toEqual([]);
    for (const t of PURGE_DELETE) expect(out.some((l) => l.trim().startsWith(t)), t).toBe(true);
    expect(out.find((l) => l.trim().startsWith("events"))).toMatch(/ 30$/);
    expect(rows(a.id)).toEqual(before);
    expect(store.listAudit().map((e) => e.action)).toEqual(["app.create"]);
  });

  it("an unknown app or no name: exit 1", async () => {
    expect(await runPurgeCommand(["nope"], cli("nope").deps)).toBe(1);
    expect(await runPurgeCommand([], cli("").deps)).toBe(1);
  });
});

describe("while the server is up", () => {
  it("an interrupted purge leaves the app, and running it again finishes it", async () => {
    const a = seed("shop", "a");
    const b = seed("blog", "b");
    const before = rows(b.id);
    store.disableApp("shop", "cli");
    let batches = 0;
    await expect(purge(a, {
      onBatch: () => {
        if (++batches === 3) throw new Error("interrupted");
      },
    })).rejects.toThrow("interrupted");
    expect(store.appById(a.id)).toBeDefined();
    expect(rows(a.id).events).toBeGreaterThan(0);
    expect(rows(a.id).events).toBeLessThan(30);
    expect(store.purgeStarted(a.id)).toBe(true);
    const out: string[] = [];
    expect(await runPurgeCommand(["shop"], { store, ask: async () => "shop", print: (l) => out.push(l), purge: { pauseMs: 0, checkpointRetryMs: 1 } })).toBe(0);
    expect(out[0]).toBe('Resuming the purge of "shop" deletes, for good:');
    expect(Object.values(rows(a.id)).every((count) => count === 0)).toBe(true);
    expect(store.appById(a.id)).toBeUndefined();
    expect(rows(b.id)).toEqual(before);
  });

  it("Ctrl-C stops between batches, audited with the counts so far; the next run resumes and audits the totals over both runs", async () => {
    const a = seed("shop", "a");
    const seeded = rows(a.id);
    store.disableApp("shop", "cli");
    const stop = new AbortController();
    let batches = 0;
    const out: string[] = [];
    const deps = (extra: Partial<PurgeCommandDeps["purge"]> = {}): PurgeCommandDeps => ({
      store,
      ask: async () => "shop",
      print: (l) => out.push(l),
      armStop: () => stop.signal,
      purge: { pauseMs: 0, batchRows: 7, checkpointRetryMs: 1, ...extra },
    });
    expect(await runPurgeCommand(["shop"], deps({ onBatch: () => (++batches === 3 ? stop.abort() : undefined) }))).toBe(130);
    expect(out.at(-1)).toBe("Interrupted: 21 rows deleted so far. Run the same command again to finish.");
    const interrupted = store.listAudit().find((e) => e.action === "app.purge_interrupted")!;
    expect(interrupted.app_id).toBe(a.id);
    expect(JSON.parse(interrupted.detail!)).toMatchObject({ reason: "signal", rows: { events: 21, profiles: 0 } });
    expect(rows(a.id).events).toBe(9);

    out.length = 0;
    const again = new AbortController();
    expect(await runPurgeCommand(["shop"], { ...deps(), armStop: () => again.signal })).toBe(0);
    expect(out[0]).toBe('Resuming the purge of "shop" deletes, for good:');
    expect(out.at(-2)).toMatch(/^Purged "shop": \d+ rows deleted over 2 runs/);
    const done = JSON.parse(store.listAudit().find((e) => e.action === "app.purge")!.detail!) as { rows: Record<string, number>; resumed: number };
    // Every row seeded, over both runs: not only what the second run deleted.
    expect(done.rows).toEqual(seeded);
    expect(done.resumed).toBe(1);
    expect(store.listAudit().filter((e) => e.app_id === a.id).map((e) => e.action))
      .toEqual(["app.purge", "app.purge_started", "app.purge_interrupted", "app.purge_started", "app.disable", "app.create"]);
  });

  it("the totals stay exact after a run that was killed (no interruption recorded) or failed", async () => {
    const a = seed("shop", "a");
    const seeded = rows(a.id);
    store.disableApp("shop", "cli");
    // A run killed after two batches: nothing but its batches reached the database.
    store.startPurge(a.id, "cli", purgePlan(store, a));
    store.purgeBatch("events", a.id, 10);
    store.purgeBatch("events", a.id, 10);
    // A run that failed.
    let batches = 0;
    await expect(purge(a, { onBatch: () => {
      if (++batches === 2) throw new Error("disk on fire");
    } })).rejects.toThrow("disk on fire");
    expect(JSON.parse(store.listAudit().find((e) => e.action === "app.purge_interrupted")!.detail!)).toMatchObject({ reason: "error", rows: { events: 30 } });
    const total = await purge(a);
    expect(total.tables).toEqual(seeded);
    expect(total.resumed).toBe(2);
    expect(JSON.parse(store.listAudit()[0]!.detail!)).toMatchObject({ rows: seeded, resumed: 2 });
    // The purge's own count is gone with the app.
    expect(sql("SELECT count(*) AS n FROM purge_progress")).toEqual([{ n: 0 }]);
  });

  it("each batch commits on its own: another writer gets the lock between batches without waiting", async () => {
    const a = seed("shop", "a");
    store.disableApp("shop", "cli");
    const other = new DatabaseSync(path);
    other.exec("PRAGMA busy_timeout = 0");
    let writes = 0;
    try {
      await purge(a, {
        onBatch: () => {
          other.prepare("INSERT OR REPLACE INTO db_size_samples (ts, bytes) VALUES (?, ?)").run(++writes, 1);
        },
      });
    } finally {
      other.close();
    }
    expect(writes).toBeGreaterThan(PURGE_DELETE.length);
  });

  it("rows written for the app during the purge are deleted by its last step", async () => {
    const a = seed("shop", "a");
    store.disableApp("shop", "cli");
    let wrote = false;
    const done = await purge(a, {
      onBatch: (table) => {
        // The server flushes a 403 count for the disabled app after its table was emptied.
        if (table === "scrub_mismatches" && !wrote) {
          wrote = true;
          store.addIngestRejections([{ app_id: a.id, minute: T0, status: 403, n: 1 }]);
        }
      },
    });
    expect(done.tables.ingest_rejections).toBe(2);
    expect(rows(a.id).ingest_rejections).toBe(0);
    expect(store.appById(a.id)).toBeUndefined();
  });
});

describe("queued alerts never carry a purged app", () => {
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await sleep(5);
    expect(cond()).toBe(true);
  }

  it("a retry after the purge: the shop-only message is dropped, the mixed one goes out without shop", async () => {
    const a = store.createApp("shop", "test").app;
    const b = store.createApp("blog", "test").app;
    let fail = true;
    const { channel, sent } = recordingChannel("webhook", { next: () => (fail ? { ok: false, error: "HttpStatus", code: 503 } : { ok: true, code: 204 }) });
    store.writeAlertChannels([{ channel: channel.name, label: channel.label }]);
    const alerter = new Alerter({ store, channels: [channel], now: () => clock, log: () => {}, limits: { retryDelaysMs: [60, 60] } });
    // Two minutes red: one mixed message (shop + blog).
    for (let i = 0; i < 2; i++) {
      clock += MIN;
      emit(store, clock, a.id, [{ signal: "x", severity: "critical", summary: marker("shopsummary") }]);
      emit(store, clock, b.id, [{ signal: "x", severity: "critical" }]);
    }
    alerter.sweep();
    // Then a shop-only one.
    clock += MIN;
    emit(store, clock, a.id, [{ signal: "y", severity: "critical" }]);
    clock += MIN;
    emit(store, clock, a.id, [{ signal: "y", severity: "critical" }]);
    alerter.sweep();
    await until(() => sent.length === 2);
    expect(sent.map((m) => m.items.map((i) => i.app).sort())).toEqual([["blog", "shop"], ["shop"]]);

    // Both failed and wait in memory for their retry; shop is purged meanwhile.
    store.disableApp("shop", "cli");
    await purge(store.appById(a.id)!);
    fail = false;
    await until(() => store.recentDeliveries().every((d) => d.status === "delivered"));
    await sleep(100);
    alerter.stop();
    const after = sent.slice(2);
    expect(after).toHaveLength(1);
    expect(after[0]!.items.map((i) => i.app)).toEqual(["blog"]);
    expect(JSON.stringify(after)).not.toContain("shop");
    expect(JSON.stringify(after)).not.toContain(marker("shopsummary"));
  });
});
