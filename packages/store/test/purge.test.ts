// app:purge in the store (DECISIONS #126): every app_id table is covered, a
// purge refuses an enabled app, and writes that arrive for a purged app are
// dropped instead of bringing rows back.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR_MS, openStore, PURGE_DELETE, PURGE_TABLES, type Store } from "@abigaail/store";

const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);
let dir: string;
let path: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-purge-store-"));
  path = join(dir, "test.db");
  store = openStore(path, { now: () => T0 });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function count(table: string, appId: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE app_id = ?`).get(appId) as { n: number }).n);
  } finally {
    db.close();
  }
}

const empty = () => ({ tables: Object.fromEntries(PURGE_DELETE.map((t) => [t, 0])) as never, deliveries_deleted: 0, deliveries_rewritten: 0, system_rows: 0 });

describe("every table with an app_id is covered by the purge", () => {
  it("the schema's app_id tables are exactly the keys of PURGE_TABLES", () => {
    const db = new DatabaseSync(path, { readOnly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => (db.prepare("SELECT name FROM pragma_table_info(?)").all(t) as { name: string }[]).some((c) => c.name === "app_id"));
    db.close();
    // A new table with an app_id must be added to PURGE_TABLES, as "delete" or as "keep" with a reason.
    expect(tables.sort()).toEqual(Object.keys(PURGE_TABLES).sort());
  });

  it("only audit_log is kept", () => {
    expect(Object.entries(PURGE_TABLES).filter(([, what]) => what === "keep").map(([t]) => t)).toEqual(["audit_log"]);
  });
});

describe("a purge needs a disabled app", () => {
  it("startPurge and finishPurge refuse an enabled app and change nothing", () => {
    const a = store.createApp("a", "test").app.id;
    store.addIngestRejections([{ app_id: a, minute: T0, status: 403, n: 1 }]);
    expect(() => store.startPurge(a, "cli", empty())).toThrow(/not disabled/);
    expect(() => store.finishPurge(a, "a", [], "cli", empty())).toThrow(/not disabled/);
    expect(store.appById(a)).toBeDefined();
    expect(count("ingest_rejections", a)).toBe(1);
    expect(store.listAudit().map((e) => e.action)).toEqual(["app.create"]);
  });

  it("finishPurge removes the app and what is left in one step, and audits counts only", () => {
    const a = store.createApp("a", "test").app.id;
    store.addIngestRejections([{ app_id: a, minute: T0, status: 403, n: 2 }]);
    store.disableApp("a", "test");
    const total = store.finishPurge(a, "a", [], "cli", empty());
    expect(total.tables.ingest_rejections).toBe(1);
    expect(store.appById(a)).toBeUndefined();
    expect(count("ingest_rejections", a)).toBe(0);
    const entry = store.listAudit()[0]!;
    expect(entry).toMatchObject({ actor: "cli", action: "app.purge", app_id: a });
    const detail = JSON.parse(entry.detail!) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(["deliveries_deleted", "deliveries_rewritten", "rows", "system_rows"]);
    for (const n of Object.values(detail.rows as Record<string, unknown>)) expect(typeof n).toBe("number");
  });
});

describe("writes for a purged app are dropped", () => {
  let a: string;
  let b: string;
  beforeEach(() => {
    a = store.createApp("a", "test").app.id;
    b = store.createApp("b", "test").app.id;
    store.disableApp("a", "test");
    store.finishPurge(a, "a", [], "cli", empty());
  });

  const finding = (app_id: string) => ({ app_id, agent: "health", fingerprint: "health:x:", signal: "x", severity: "warning" as const, summary: "s", action: "a", evidence: {} });

  it("an agent run that read the app before the purge keeps the other apps' findings", () => {
    expect(() => store.recordRun({ agent: "health", started_at: T0, finished_at: T0, outcome: "ok", apps_ok: 2, apps_failed: 0 }, [finding(a), finding(b)], [a, b])).not.toThrow();
    expect(count("findings", a)).toBe(0);
    expect(count("findings", b)).toBe(1);
  });

  it("buffered refusal and rescrub counts", () => {
    store.addIngestRejections([{ app_id: a, minute: T0, status: 403, n: 5 }, { app_id: "", minute: T0, status: 401, n: 1 }, { app_id: b, minute: T0, status: 429, n: 1 }]);
    store.addScrubMismatches([{ app_id: a, minute: T0, n: 3 }, { app_id: b, minute: T0, n: 1 }]);
    expect(count("ingest_rejections", a)).toBe(0);
    expect(count("ingest_rejections", "")).toBe(1);
    expect(count("ingest_rejections", b)).toBe(1);
    expect(count("scrub_mismatches", a)).toBe(0);
    expect(count("scrub_mismatches", b)).toBe(1);
  });

  it("the rollup and an ingest batch in flight", () => {
    expect(store.rollupHour(a, Math.floor(T0 / HOUR_MS) * HOUR_MS)).toBe(false);
    expect(count("rollup_hours", a)).toBe(0);
    const r = store.insertBatch(a, {
      receivedAt: T0, release: "r1", environment: "test",
      events: [{ event: { type: "request", event_id: "00000000-0000-4000-8000-000000000001", client_ts: T0, method: "GET", route: "/", status: 200, duration_ms: 1 }, derived: { ts: T0, bot_class: "human", visitor_hash: "v", browser: null } }],
    });
    expect(r.inserted).toBe(0);
    expect(count("events", a)).toBe(0);
    expect(count("deploys", a)).toBe(0);
  });

  it("an alert sweep that read the app writes nothing and fails, to start again without it", () => {
    const state = (app_id: string) => ({ app_id, fingerprint: "health:x:", state: "firing" as const, sent: null, finding_id: 1, changed_at: T0, fired_at: null, fired_summary: null, flaps: 0 });
    expect(() => store.applyAlerts([state(a), state(b)], [])).toThrow(/no longer exists/);
    expect(count("alert_state", a) + count("alert_state", b)).toBe(0);
    store.applyAlerts([state(b)], []);
    expect(count("alert_state", b)).toBe(1);
  });
});
