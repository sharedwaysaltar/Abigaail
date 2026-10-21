import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AbigaailEvent, Environment } from "@abigaail/schema";
import { generateIngestKey, hashIngestKey } from "./keys.js";
import { MIGRATION_DROP_SALTS, MIGRATIONS, ROLLUP_VERSION } from "./migrations.js";
import { APP_COLUMNS, HOUR_MS, StoreReader, type AlertState, type App, type DeliveryStatus, type RetentionName, type RunOutcome, type Severity, type StatKind } from "./reader.js";
import { toRow, type Derived, type EventRow } from "./rows.js";
import { checkpointTruncate, convertToIncremental, incrementalVacuum, type VacuumConversion } from "./vacuum.js";

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  app_id: string | null;
  detail: string | null;
}

export interface IngestBatch {
  receivedAt: number;
  release: string;
  environment: Environment;
  events: { event: AbigaailEvent; derived: Derived }[];
}

export interface StoreOptions {
  now?: () => number;
}

/** Lowercase app names: letters, digits and hyphens, up to 63 chars. */
export const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A finding as an agent run reports it; the runner has already set the fingerprint. */
export interface FindingInput {
  app_id: string | null;
  agent: string;
  fingerprint: string;
  signal: string;
  severity: Severity;
  summary: string;
  cause?: string | null;
  action: string;
  evidence: Record<string, unknown>;
  /** A state rather than a signal: resolves on the first evaluated run without it. */
  fact?: boolean;
}

export interface RunInput {
  agent: string;
  started_at: number;
  finished_at: number;
  outcome: RunOutcome;
  error_class?: string | null;
  apps_ok: number;
  apps_failed: number;
  /** A maintenance run (retention) that ended with work left. */
  behind?: boolean;
}

export interface RecordRunOptions {
  /** A finding resolved this recently is reopened instead of duplicated. Default 30 min. */
  cooldownMs?: number;
  /** Consecutive evaluated runs without the finding before it resolves. Default 3. */
  resolveAfter?: number;
  /**
   * Only findings resolved at or after this time may be reopened by the
   * cooldown. The runner sets it to its start after a gap longer than the
   * agent's resolve window, so the cooldown never reaches across unobserved downtime.
   */
  reopenFrom?: number;
}

/** A message to queue: one channel, the findings it carries. */
export interface DeliveryInput {
  delivery_id: string;
  channel: string;
  kind: "alert" | "storm" | "test";
  /** JSON of the message (allowlisted finding fields only). */
  payload: string;
  status: "pending" | "suppressed";
  items: { app_id: string | null; finding_id: number | null; fingerprint: string; change: "firing" | "recovered" }[];
}

/** A queued message as the sender needs it. */
export interface PendingDelivery {
  id: number;
  delivery_id: string;
  channel: string;
  kind: "alert" | "storm" | "test";
  created_at: number;
  payload: string;
  attempts: number;
  next_attempt_at: number | null;
}

const STAT_KINDS: readonly StatKind[] = ["route", "host", "referrer", "error", "metric", "app"];
const DAY_MS = 86_400_000;

/** Tables with an app_id whose old rows retention deletes one app_id at a time. */
export type ScopedTable = "events" | "hourly_route_stats" | "rollup_hours" | "daily_uniques" | "findings" | "ingest_rejections" | "audit_log" | "alert_state";
const SCOPED_TABLES: readonly ScopedTable[] = ["events", "hourly_route_stats", "rollup_hours", "daily_uniques", "findings", "ingest_rejections", "audit_log", "alert_state"];

/** What deleteExpired removes; events and rollups have their own methods (roll before delete, tables kept in step). */
export type ExpiringTable =
  | "daily_uniques" | "findings" | "ingest_rejections" | "audit_log" | "agent_runs" | "db_size_samples" | "alert_deliveries" | "alert_state";

/**
 * One bounded batch per statement. App tables take (scope, cutoff, limit) or,
 * for app_id NULL rows, (cutoff, limit); system tables take (cutoff, limit).
 * Only resolved findings expire, and each agent's newest ok run is kept.
 * Pending messages never expire (the sender gives them up); deleting a
 * message deletes its alert_items (ON DELETE CASCADE). Only alert states
 * that are ok and owe no message expire.
 */
const EXPIRE_SQL: Record<ExpiringTable, { app?: string; none?: string }> = {
  daily_uniques: {
    app: `DELETE FROM daily_uniques WHERE app_id = ? AND day IN (
            SELECT day FROM daily_uniques WHERE app_id = ? AND day < ? ORDER BY day LIMIT ?)`,
  },
  findings: {
    app: `DELETE FROM findings WHERE app_id = ? AND id IN (
            SELECT id FROM findings WHERE app_id = ? AND state = 'resolved' AND resolved_at < ? LIMIT ?)`,
    none: `DELETE FROM findings WHERE app_id IS NULL AND id IN (
             SELECT id FROM findings WHERE app_id IS NULL AND state = 'resolved' AND resolved_at < ? LIMIT ?)`,
  },
  ingest_rejections: {
    app: `DELETE FROM ingest_rejections WHERE app_id = ? AND minute IN (
            SELECT DISTINCT minute FROM ingest_rejections WHERE app_id = ? AND minute < ? ORDER BY minute LIMIT ?)`,
  },
  audit_log: {
    app: `DELETE FROM audit_log WHERE app_id = ? AND id IN (
            SELECT id FROM audit_log WHERE app_id = ? AND ts < ? ORDER BY id LIMIT ?)`,
    none: `DELETE FROM audit_log WHERE app_id IS NULL AND id IN (
             SELECT id FROM audit_log WHERE app_id IS NULL AND ts < ? ORDER BY id LIMIT ?)`,
  },
  agent_runs: {
    none: `DELETE FROM agent_runs WHERE id IN (
             SELECT id FROM agent_runs WHERE finished_at < ?
               AND id NOT IN (SELECT max(id) FROM agent_runs WHERE outcome = 'ok' GROUP BY agent)
             ORDER BY finished_at LIMIT ?)`,
  },
  db_size_samples: {
    none: "DELETE FROM db_size_samples WHERE ts IN (SELECT ts FROM db_size_samples WHERE ts < ? ORDER BY ts LIMIT ?)",
  },
  alert_deliveries: {
    none: `DELETE FROM alert_deliveries WHERE id IN (
             SELECT id FROM alert_deliveries WHERE created_at < ? AND status <> 'pending' ORDER BY created_at LIMIT ?)`,
  },
  alert_state: {
    app: `DELETE FROM alert_state WHERE app_id = ? AND rowid IN (
            SELECT rowid FROM alert_state WHERE app_id = ? AND state = 'ok' AND (sent IS NULL OR sent = 'recovered') AND changed_at < ? LIMIT ?)`,
    none: `DELETE FROM alert_state WHERE app_id IS NULL AND rowid IN (
             SELECT rowid FROM alert_state WHERE app_id IS NULL AND state = 'ok' AND (sent IS NULL OR sent = 'recovered') AND changed_at < ? LIMIT ?)`,
  },
};

export function openStore(path: string, opts: StoreOptions = {}): Store {
  return new Store(path, opts);
}

/**
 * Read-only access for agent workers: no pragmas, no migrations, and SQLite
 * refuses every write on this connection.
 */
export function openReadOnly(path: string): StoreReader {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return new StoreReader(db);
}

export function openWritable(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    -- Must come first: a new file is incremental only if this is set before its
    -- first page is written. On an existing file it changes nothing until a
    -- VACUUM (the one-time conversion in vacuum.ts).
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    -- Overwrite deleted content instead of leaving it in free space.
    PRAGMA secure_delete = ON;
  `);
  return db;
}

/**
 * The only code that writes the database. Every method that reads or writes
 * monitored-app data takes an appId and filters by it. Reads live in StoreReader.
 */
export class Store extends StoreReader {
  private readonly now: () => number;

  constructor(readonly path: string, opts: StoreOptions = {}) {
    super(openWritable(path));
    this.now = opts.now ?? Date.now;
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    if (user_version < MIGRATION_DROP_SALTS) this.purgeFreeSpace();
  }

  /**
   * Rebuild the database so no deleted content survives anywhere in the file:
   * secure_delete only zeroes rows deleted while it was on, and the first
   * chunk 2 build rotated salts without it. VACUUM cannot run inside a
   * transaction; its scratch copy is kept in memory, not in a temp file. The
   * checkpoint then moves the rebuilt pages into the main file and truncates the WAL.
   */
  private purgeFreeSpace(): void {
    this.db.exec("PRAGMA temp_store = MEMORY");
    try {
      this.db.exec("VACUUM");
    } finally {
      this.db.exec("PRAGMA temp_store = DEFAULT");
    }
    this.checkpoint();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private audit(actor: string, action: string, appId: string | null, detail?: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO audit_log (ts, actor, action, app_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(this.now(), actor, action, appId, detail ? JSON.stringify(detail) : null);
  }

  // ---- apps ---------------------------------------------------------------

  /** Create an app. The returned key is shown once; only its hash is stored. */
  createApp(name: string, actor: string): { app: App; key: string } {
    if (!APP_NAME_RE.test(name)) throw new Error("app name must be lowercase letters, digits and hyphens");
    const key = generateIngestKey();
    const app: App = { id: randomUUID(), name, created_at: this.now(), disabled_at: null, last_event_at: null, region: null };
    this.tx(() => {
      this.db
        .prepare("INSERT INTO apps (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(app.id, app.name, hashIngestKey(key), app.created_at);
      this.audit(actor, "app.create", app.id, { name });
    });
    return { app, key };
  }

  /** Revoke an app's key. Returns false if no such app or already disabled. */
  disableApp(name: string, actor: string): boolean {
    return this.tx(() => {
      const app = this.appByName(name);
      if (!app || app.disabled_at !== null) return false;
      this.db.prepare("UPDATE apps SET disabled_at = ? WHERE id = ?").run(this.now(), app.id);
      this.audit(actor, "app.disable", app.id, { name });
      return true;
    });
  }

  appByKey(key: string): App | undefined {
    return this.db
      .prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE key_hash = ?`)
      .get(hashIngestKey(key)) as App | undefined;
  }

  listAudit(limit = 100): AuditEntry[] {
    return this.db
      .prepare("SELECT id, ts, actor, action, app_id, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as AuditEntry[];
  }

  // ---- events -------------------------------------------------------------

  /**
   * Append a validated batch in one transaction. Duplicate event_ids (retries)
   * are ignored and counted. Also records the deploy and the app's last-seen
   * time, and each boot sets the app's region (NULL if it sent none).
   * `rows` holds only the rows actually inserted, so a retried batch is never
   * reported twice (the Live view relies on this).
   */
  insertBatch(appId: string, batch: IngestBatch): { inserted: number; duplicates: number; rows: EventRow[] } {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        app_id, event_id, ts, received_at, client_ts, type, release, environment,
        route, method, status, duration_ms, host, name, value, sample_rate,
        visitor_hash, browser, bot_class, attrs, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    return this.tx(() => {
      let inserted = 0;
      const rows: EventRow[] = [];
      let latestBoot: { ts: number; region: string | null } | undefined;
      for (const { event, derived } of batch.events) {
        const r = toRow(event, derived);
        const { changes } = insert.run(
          appId, r.event_id, r.ts, batch.receivedAt, r.client_ts, r.type, batch.release, batch.environment,
          r.route, r.method, r.status, r.duration_ms, r.host, r.name, r.value, r.sample_rate,
          r.visitor_hash, r.browser, r.bot_class, r.attrs, r.parent_id,
        );
        inserted += Number(changes);
        if (changes) rows.push(r);
        if (changes && event.type === "lifecycle" && event.kind === "boot") latestBoot = { ts: r.ts, region: event.region ?? null };
      }
      // The latest boot wins, also over boots stored by earlier batches.
      if (latestBoot) {
        this.db
          .prepare(`UPDATE apps SET region = ? WHERE id = ? AND NOT EXISTS (
                      SELECT 1 FROM events WHERE app_id = ? AND type = 'lifecycle' AND name = 'boot' AND ts > ?)`)
          .run(latestBoot.region, appId, appId, latestBoot.ts);
      }
      this.db
        .prepare(`
          INSERT INTO deploys (app_id, release, environment, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (app_id, release, environment)
          DO UPDATE SET last_seen = max(last_seen, excluded.last_seen)`)
        .run(appId, batch.release, batch.environment, batch.receivedAt, batch.receivedAt);
      this.db
        .prepare("UPDATE apps SET last_event_at = max(coalesce(last_event_at, 0), ?) WHERE id = ?")
        .run(batch.receivedAt, appId);
      return { inserted, duplicates: batch.events.length - inserted, rows };
    });
  }

  // ---- agents ---------------------------------------------------------------

  /**
   * Log one agent run and apply its findings, in one transaction.
   *
   * Each emitted finding is upserted by (app, fingerprint): hits+1, misses
   * reset. An open finding of this agent that was not emitted gets misses+1
   * only if its scope is in `evaluated` (apps the agent finished successfully;
   * null = Abigaail itself), and resolves after `resolveAfter` such runs, or
   * after the first one if it is a fact (FindingInput.fact). Runs
   * that failed, timed out or were skipped change no finding, so an agent that
   * cannot see an app never "recovers" it.
   */
  recordRun(run: RunInput, findings: readonly FindingInput[], evaluated: readonly (string | null)[], opts: RecordRunOptions = {}): void {
    const cooldownMs = opts.cooldownMs ?? 30 * 60_000;
    const resolveAfter = opts.resolveAfter ?? 3;
    const now = run.finished_at;
    this.tx(() => {
      this.db
        .prepare(`INSERT INTO agent_runs (agent, started_at, finished_at, outcome, duration_ms, findings, error_class, apps_ok, apps_failed, behind)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.agent, run.started_at, run.finished_at, run.outcome, run.finished_at - run.started_at,
          run.outcome === "ok" ? findings.length : 0, run.error_class ?? null, run.apps_ok, run.apps_failed, run.behind ? 1 : 0);
      if (run.outcome !== "ok") return;

      // One finding per (scope, fingerprint) per run: the last one wins.
      const emitted = new Map<string, FindingInput>();
      for (const f of findings) emitted.set(`${f.app_id ?? ""}\n${f.fingerprint}`, f);

      const findOpen = this.db.prepare(
        "SELECT id FROM findings WHERE coalesce(app_id, '') = ? AND fingerprint = ? AND state = 'open'");
      const findRecent = this.db.prepare(`
        SELECT id FROM findings WHERE coalesce(app_id, '') = ? AND fingerprint = ? AND state = 'resolved'
          AND resolved_at >= ? AND resolved_reason IS NULL ORDER BY resolved_at DESC, id DESC LIMIT 1`);
      // critical_streak: consecutive emissions at critical. A miss neither counts nor
      // breaks it (recovery needs 3 misses); an emission at any other severity resets it.
      const refresh = this.db.prepare(`
        UPDATE findings SET
          critical_streak = CASE WHEN ? <> 'critical' THEN 0 WHEN state = 'open' THEN critical_streak + 1 ELSE 1 END,
          state = 'open', resolved_at = NULL, resolved_reason = NULL, hits = CASE WHEN state = 'open' THEN hits + 1 ELSE 1 END,
          misses = 0, signal = ?, severity = ?, summary = ?, cause = ?, action = ?, evidence = ?, resolves = ?,
          last_seen = ?
        WHERE id = ?`);
      const insert = this.db.prepare(`
        INSERT INTO findings (app_id, agent, fingerprint, signal, severity, state, summary, cause, action, evidence,
                              resolves, hits, misses, critical_streak, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`);

      for (const f of emitted.values()) {
        const scope = f.app_id ?? "";
        const evidence = JSON.stringify(f.evidence);
        const resolves = f.fact ? "fact" : "misses";
        const reopenSince = Math.max(now - cooldownMs, opts.reopenFrom ?? -Infinity);
        const existing = (findOpen.get(scope, f.fingerprint) ?? findRecent.get(scope, f.fingerprint, reopenSince)) as
          | { id: number }
          | undefined;
        if (existing) {
          refresh.run(f.severity, f.signal, f.severity, f.summary, f.cause ?? null, f.action, evidence, resolves, now, existing.id);
        } else {
          insert.run(f.app_id, f.agent, f.fingerprint, f.signal, f.severity, f.summary, f.cause ?? null, f.action,
            evidence, resolves, f.severity === "critical" ? 1 : 0, now, now);
        }
      }

      const openOfScope = this.db.prepare(
        "SELECT id, fingerprint FROM findings WHERE agent = ? AND coalesce(app_id, '') = ? AND state = 'open'");
      // A fact resolves on its first miss; a signal after resolveAfter misses.
      const miss = this.db.prepare(`
        UPDATE findings SET misses = misses + 1,
          state = CASE WHEN resolves = 'fact' OR misses + 1 >= ? THEN 'resolved' ELSE state END,
          resolved_at = CASE WHEN resolves = 'fact' OR misses + 1 >= ? THEN ? ELSE resolved_at END
        WHERE id = ?`);
      for (const appId of new Set(evaluated)) {
        const scope = appId ?? "";
        for (const row of openOfScope.all(run.agent, scope) as { id: number; fingerprint: string }[]) {
          if (!emitted.has(`${scope}\n${row.fingerprint}`)) miss.run(resolveAfter, resolveAfter, now, row.id);
        }
      }
    });
  }

  /**
   * Close an agent's open findings, one scope at a time (each app, then
   * Abigaail itself), as not observed: Abigaail was down longer than the
   * agent's resolve window, so nothing says they stayed true. They are never
   * reopened by the cooldown; one that is still true starts fresh with its own
   * first_seen and hits. Returns how many were closed.
   */
  resolveUnobserved(agent: string, at: number): number {
    return this.tx(() => {
      const close = this.db.prepare(`
        UPDATE findings SET state = 'resolved', resolved_at = ?, resolved_reason = 'not_observed'
        WHERE coalesce(app_id, '') = ? AND agent = ? AND state = 'open'`);
      let n = 0;
      for (const scope of [...this.listApps().map((a) => a.id), ""]) n += Number(close.run(at, scope, agent).changes);
      return n;
    });
  }

  /**
   * Roll one UTC hour of an app's raw events into hourly_route_stats, and
   * refresh that day's unique humans. Idempotent: re-running replaces the hour,
   * so late events are picked up by rolling it again.
   *
   * Never rolls an hour down: events are append-only, so fewer events than the
   * hour was rolled with means retention deleted them. The rolled hour is then
   * kept as it is (returns false), so baselines never lose it. For the same
   * reason a day's unique humans only ever grow.
   */
  rollupHour(appId: string, hour: number): boolean {
    if (hour % HOUR_MS !== 0) throw new Error("hour must be the start of a UTC hour");
    const end = hour + HOUR_MS;
    return this.tx(() => {
      const events = this.countEventsBetween(appId, hour, end);
      const prev = this.db.prepare("SELECT events FROM rollup_hours WHERE app_id = ? AND hour = ?").get(appId, hour) as
        | { events: number }
        | undefined;
      if (prev && events < Number(prev.events)) return false;
      this.db.prepare("DELETE FROM hourly_route_stats WHERE app_id = ? AND hour = ?").run(appId, hour);
      const insert = this.db.prepare(`
        INSERT INTO hourly_route_stats (app_id, hour, kind, key, n, weighted_n, status_5xx, status_4xx,
                                        status_401_403, failures, p50, p95, p99, uniques)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const kind of STAT_KINDS) {
        for (const r of this.statsFor(appId, kind, hour, end)) {
          insert.run(appId, hour, kind, r.key, r.n, r.weighted_n, r.status_5xx, r.status_4xx, r.status_401_403,
            r.failures, r.p50, r.p95, r.p99, r.uniques);
        }
      }
      this.db
        .prepare(`INSERT INTO rollup_hours (app_id, hour, events, rolled_at, version) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT (app_id, hour)
                  DO UPDATE SET events = excluded.events, rolled_at = excluded.rolled_at, version = excluded.version`)
        .run(appId, hour, events, this.now(), ROLLUP_VERSION);
      const dayStart = Math.floor(hour / DAY_MS) * DAY_MS;
      this.db
        .prepare(`INSERT INTO daily_uniques (app_id, day, humans) VALUES (?, ?, ?)
                  ON CONFLICT (app_id, day) DO UPDATE SET humans = max(humans, excluded.humans)`)
        .run(appId, new Date(dayStart).toISOString().slice(0, 10), this.uniqueHumans(appId, dayStart, dayStart + DAY_MS));
      return true;
    });
  }

  /**
   * Hour starts in [from, to) not rolled up yet, or rolled by an older rollup
   * version. Those keep their rows (baselines still work) until re-rolled.
   */
  missingHours(appId: string, from: number, to: number): number[] {
    const first = Math.ceil(from / HOUR_MS) * HOUR_MS;
    const done = new Set(
      (this.db
        .prepare("SELECT hour FROM rollup_hours WHERE app_id = ? AND hour >= ? AND hour < ? AND version >= ?")
        .all(appId, first, to, ROLLUP_VERSION) as { hour: number }[]).map((r) => r.hour),
    );
    const out: number[] = [];
    for (let h = first; h < to; h += HOUR_MS) if (!done.has(h)) out.push(h);
    return out;
  }

  /** Add ingest refusal counts. appId '' = unknown key. */
  addIngestRejections(rows: readonly { app_id: string; minute: number; status: number; n: number }[]): void {
    if (!rows.length) return;
    const upsert = this.db.prepare(`
      INSERT INTO ingest_rejections (app_id, minute, status, n) VALUES (?, ?, ?, ?)
      ON CONFLICT (app_id, minute, status) DO UPDATE SET n = n + excluded.n`);
    this.tx(() => {
      for (const r of rows) upsert.run(r.app_id, r.minute, r.status, r.n);
    });
  }

  /** Record the current database size, for the Watchdog's growth estimate. */
  sampleDbSize(): void {
    this.db.prepare("INSERT OR REPLACE INTO db_size_samples (ts, bytes) VALUES (?, ?)").run(this.now(), this.dbBytes());
  }

  // ---- retention (DECISIONS #88) ---------------------------------------------

  /**
   * Every app_id that has rows in `table`, found by stepping through its
   * app_id index (each step a single lookup), so disabled apps and app_ids with
   * no apps row are included. NULL app_ids are not returned.
   */
  retentionScopes(table: ScopedTable): string[] {
    if (!SCOPED_TABLES.includes(table)) throw new RangeError("not a scoped table");
    const first = this.db.prepare(`SELECT min(app_id) AS id FROM ${table}`);
    const next = this.db.prepare(`SELECT min(app_id) AS id FROM ${table} WHERE app_id > ?`);
    const out: string[] = [];
    let row = first.get() as { id: string | null };
    while (row.id !== null) {
      out.push(row.id);
      row = next.get(row.id) as { id: string | null };
    }
    return out;
  }

  /**
   * Delete up to `limit` raw events of one app from its oldest stored hour, if
   * that hour starts before `before` (an hour start). Roll before delete: the
   * hour is rolled up first unless it already is at the current rollup
   * version, so baselines keep it. `more`: older events are still left.
   */
  deleteOldEvents(appId: string, before: number, limit: number): { deleted: number; rolled: boolean; more: boolean } {
    if (before % HOUR_MS !== 0) throw new Error("before must be the start of a UTC hour");
    const oldest = this.oldestEventTs(appId);
    if (oldest === undefined || oldest >= before) return { deleted: 0, rolled: false, more: false };
    const hour = Math.floor(oldest / HOUR_MS) * HOUR_MS;
    const rolledAt = this.db.prepare("SELECT version FROM rollup_hours WHERE app_id = ? AND hour = ?").get(appId, hour) as
      | { version: number }
      | undefined;
    let rolled = false;
    if (!rolledAt || Number(rolledAt.version) < ROLLUP_VERSION) {
      this.rollupHour(appId, hour);
      rolled = true;
    }
    const deleted = this.tx(() =>
      Number(
        this.db
          .prepare(`DELETE FROM events WHERE app_id = ? AND event_id IN (
                      SELECT event_id FROM events WHERE app_id = ? AND ts < ? LIMIT ?)`)
          .run(appId, appId, Math.min(hour + HOUR_MS, before), limit).changes,
      ),
    );
    const left = this.oldestEventTs(appId);
    return { deleted, rolled, more: left !== undefined && left < before };
  }

  /**
   * Delete one app's rolled-up hours before `before`, at most `hours` hours at
   * a time. hourly_route_stats and rollup_hours go together in one
   * transaction: a rolled hour without its stats would read as zero traffic.
   */
  deleteOldRollups(appId: string, before: number, hours: number): number {
    return this.tx(() => {
      const oldest = Math.min(
        ...[
          this.db.prepare("SELECT min(hour) AS h FROM rollup_hours WHERE app_id = ?").get(appId),
          this.db.prepare("SELECT min(hour) AS h FROM hourly_route_stats WHERE app_id = ?").get(appId),
        ].map((r) => (r as { h: number | null }).h ?? Infinity),
      );
      if (oldest >= before) return 0;
      const end = Math.min(oldest + hours * HOUR_MS, before);
      const stats = this.db.prepare("DELETE FROM hourly_route_stats WHERE app_id = ? AND hour < ?").run(appId, end).changes;
      const marks = this.db.prepare("DELETE FROM rollup_hours WHERE app_id = ? AND hour < ?").run(appId, end).changes;
      return Number(stats) + Number(marks);
    });
  }

  /**
   * Delete up to `limit` expired rows of one table and scope: an app_id, or
   * null for rows that have none (Abigaail's own findings and audit entries,
   * and the system tables). `before` is a time, or a UTC day for daily_uniques.
   */
  deleteExpired(table: ExpiringTable, scope: string | null, before: number | string, limit: number): number {
    const sql = scope === null ? EXPIRE_SQL[table].none : EXPIRE_SQL[table].app;
    if (!sql) throw new RangeError(`${table} has no ${scope === null ? "unscoped" : "app"} rows`);
    const params = scope === null ? [before, limit] : [scope, scope, before, limit];
    return this.tx(() => Number(this.db.prepare(sql).run(...params).changes));
  }

  /** Record the periods being enforced (the dashboard reads them back). Last-run fields are kept. */
  writeRetentionPolicy(rows: readonly { name: RetentionName; keep_days: number; min_days: number }[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO retention_policy (name, keep_days, min_days, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET keep_days = excluded.keep_days, min_days = excluded.min_days, updated_at = excluded.updated_at`);
    this.tx(() => {
      for (const r of rows) upsert.run(r.name, r.keep_days, r.min_days, this.now());
    });
  }

  /** Rows deleted per policy name by one retention run. */
  recordRetention(at: number, deleted: Partial<Record<RetentionName, number>>): void {
    const update = this.db.prepare("UPDATE retention_policy SET last_run_at = ?, last_deleted = ? WHERE name = ?");
    this.tx(() => {
      for (const [name, n] of Object.entries(deleted)) update.run(at, n, name);
    });
  }

  // ---- alerts (DECISIONS #95, #99) -------------------------------------------

  /** An admin action outside the app tables (actor "cli"), such as a test alert. */
  auditAction(actor: string, action: string, detail?: Record<string, unknown>): void {
    this.audit(actor, action, null, detail);
  }

  /** Record the configured channels (labels only); channels no longer configured are removed. */
  writeAlertChannels(rows: readonly { channel: string; label: string }[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO alert_channels (channel, label, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (channel) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`);
    this.tx(() => {
      const keep = new Set(rows.map((r) => r.channel));
      for (const { channel } of this.alertChannels()) {
        if (!keep.has(channel)) this.db.prepare("DELETE FROM alert_channels WHERE channel = ?").run(channel);
      }
      for (const r of rows) upsert.run(r.channel, r.label, this.now());
    });
  }

  /**
   * Apply one sweep in one transaction: the new alert states and the messages
   * they cause. Written before anything is sent, so a restart never sends a
   * message again. Returns the new deliveries' row ids, in order.
   */
  applyAlerts(states: readonly AlertState[], deliveries: readonly DeliveryInput[]): number[] {
    const upsert = this.db.prepare(`
      INSERT INTO alert_state (app_id, fingerprint, state, sent, finding_id, changed_at, fired_at, flaps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (coalesce(app_id, ''), fingerprint) DO UPDATE SET state = excluded.state, sent = excluded.sent,
        finding_id = excluded.finding_id, changed_at = excluded.changed_at, fired_at = excluded.fired_at, flaps = excluded.flaps`);
    const insert = this.db.prepare(`
      INSERT INTO alert_deliveries (delivery_id, channel, kind, created_at, payload, status, next_attempt_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const item = this.db.prepare("INSERT INTO alert_items (delivery, app_id, finding_id, fingerprint, change) VALUES (?, ?, ?, ?, ?)");
    return this.tx(() => {
      for (const s of states) upsert.run(s.app_id, s.fingerprint, s.state, s.sent, s.finding_id, s.changed_at, s.fired_at, s.flaps);
      const ids: number[] = [];
      const now = this.now();
      for (const d of deliveries) {
        const pending = d.status === "pending";
        const id = Number(insert.run(d.delivery_id, d.channel, d.kind, now, d.payload, d.status, pending ? now : null, pending ? null : now).lastInsertRowid);
        for (const i of d.items) item.run(id, i.app_id, i.finding_id, i.fingerprint, i.change);
        ids.push(id);
      }
      return ids;
    });
  }

  /**
   * Queued messages of every channel, oldest first. Only the server's sender
   * reads payloads (a message may group several apps; the dashboard reads
   * status columns and alert_items by app_id).
   */
  pendingDeliveries(): PendingDelivery[] {
    return this.db
      .prepare(`SELECT id, delivery_id, channel, kind, created_at, payload, attempts, next_attempt_at FROM alert_deliveries
                WHERE status = 'pending' ORDER BY created_at, id`)
      .all() as unknown as PendingDelivery[];
  }

  /**
   * Record one send attempt and the channel's failure streak together.
   * `retryAt` keeps it pending; otherwise a failure gives it up. A message
   * given up without an attempt (expired, queue full) passes attempted: false.
   */
  recordAttempt(id: number, channel: string, r: { ok: boolean; error?: string; code?: number; retryAt?: number; attempted?: boolean }): void {
    const now = this.now();
    const status: DeliveryStatus = r.ok ? "delivered" : r.retryAt !== undefined ? "pending" : "gave_up";
    const attempted = r.attempted ?? true;
    this.tx(() => {
      this.db
        .prepare(`UPDATE alert_deliveries SET status = ?, attempts = attempts + ?, last_attempt_at = CASE WHEN ? THEN ? ELSE last_attempt_at END,
                    last_error = ?, last_code = ?, next_attempt_at = ?, finished_at = ? WHERE id = ?`)
        .run(status, attempted ? 1 : 0, attempted ? 1 : 0, now, r.error ?? null, r.code ?? null, r.retryAt ?? null,
          status === "pending" ? null : now, id);
      if (!attempted) return;
      if (r.ok) {
        this.db.prepare("UPDATE alert_channels SET fail_streak = 0, last_ok_at = ? WHERE channel = ?").run(now, channel);
      } else {
        this.db
          .prepare("UPDATE alert_channels SET fail_streak = fail_streak + 1, last_failed_at = ?, last_error = ? WHERE channel = ?")
          .run(now, r.error ?? null, channel);
      }
    });
  }

  // ---- maintenance --------------------------------------------------------

  /**
   * Move WAL contents into the main file and truncate the WAL. busy: a reader
   * stopped it; try again. noWait: do not wait for readers (retention retries later).
   */
  checkpoint(opts: { noWait?: boolean } = {}): { busy: boolean } {
    return checkpointTruncate(this.db, opts);
  }

  /** One-time switch to incremental auto_vacuum when disk allows (see vacuum.ts). */
  convertToIncremental(opts: { freeBytes?: (dir: string) => number } = {}): VacuumConversion {
    return convertToIncremental(this.db, this.path, opts);
  }

  /** Return up to `pages` free pages to the filesystem; returns the free pages left. */
  incrementalVacuum(pages: number): number {
    return incrementalVacuum(this.db, pages);
  }
}
