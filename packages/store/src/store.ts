import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AbigaailEvent, Environment } from "@abigaail/schema";
import { generateIngestKey, hashIngestKey } from "./keys.js";
import { MIGRATION_DROP_SALTS, MIGRATIONS, ROLLUP_VERSION } from "./migrations.js";
import { APP_COLUMNS, HOUR_MS, StoreReader, type App, type RunOutcome, type Severity, type StatKind } from "./reader.js";
import { toRow, type Derived, type EventRow } from "./rows.js";

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
}

export interface RecordRunOptions {
  /** A finding resolved this recently is reopened instead of duplicated. Default 30 min. */
  cooldownMs?: number;
  /** Consecutive evaluated runs without the finding before it resolves. Default 3. */
  resolveAfter?: number;
}

const STAT_KINDS: readonly StatKind[] = ["route", "host", "referrer", "error", "metric", "app"];
const DAY_MS = 86_400_000;

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

  constructor(path: string, opts: StoreOptions = {}) {
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
        .prepare(`INSERT INTO agent_runs (agent, started_at, finished_at, outcome, duration_ms, findings, error_class, apps_ok, apps_failed)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.agent, run.started_at, run.finished_at, run.outcome, run.finished_at - run.started_at,
          run.outcome === "ok" ? findings.length : 0, run.error_class ?? null, run.apps_ok, run.apps_failed);
      if (run.outcome !== "ok") return;

      // One finding per (scope, fingerprint) per run: the last one wins.
      const emitted = new Map<string, FindingInput>();
      for (const f of findings) emitted.set(`${f.app_id ?? ""}\n${f.fingerprint}`, f);

      const findOpen = this.db.prepare(
        "SELECT id FROM findings WHERE coalesce(app_id, '') = ? AND fingerprint = ? AND state = 'open'");
      const findRecent = this.db.prepare(`
        SELECT id FROM findings WHERE coalesce(app_id, '') = ? AND fingerprint = ? AND state = 'resolved'
          AND resolved_at >= ? ORDER BY resolved_at DESC, id DESC LIMIT 1`);
      const refresh = this.db.prepare(`
        UPDATE findings SET state = 'open', resolved_at = NULL, hits = CASE WHEN state = 'open' THEN hits + 1 ELSE 1 END,
          misses = 0, signal = ?, severity = ?, summary = ?, cause = ?, action = ?, evidence = ?, resolves = ?,
          last_seen = ?
        WHERE id = ?`);
      const insert = this.db.prepare(`
        INSERT INTO findings (app_id, agent, fingerprint, signal, severity, state, summary, cause, action, evidence,
                              resolves, hits, misses, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, 0, ?, ?)`);

      for (const f of emitted.values()) {
        const scope = f.app_id ?? "";
        const evidence = JSON.stringify(f.evidence);
        const resolves = f.fact ? "fact" : "misses";
        const existing = (findOpen.get(scope, f.fingerprint) ?? findRecent.get(scope, f.fingerprint, now - cooldownMs)) as
          | { id: number }
          | undefined;
        if (existing) {
          refresh.run(f.signal, f.severity, f.summary, f.cause ?? null, f.action, evidence, resolves, now, existing.id);
        } else {
          insert.run(f.app_id, f.agent, f.fingerprint, f.signal, f.severity, f.summary, f.cause ?? null, f.action,
            evidence, resolves, now, now);
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
   * Roll one UTC hour of an app's raw events into hourly_route_stats, and
   * refresh that day's unique humans. Idempotent: re-running replaces the hour,
   * so late events are picked up by rolling it again.
   */
  rollupHour(appId: string, hour: number): void {
    if (hour % HOUR_MS !== 0) throw new Error("hour must be the start of a UTC hour");
    const end = hour + HOUR_MS;
    this.tx(() => {
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
        .run(appId, hour, this.countEventsBetween(appId, hour, end), this.now(), ROLLUP_VERSION);
      const dayStart = Math.floor(hour / DAY_MS) * DAY_MS;
      this.db
        .prepare(`INSERT INTO daily_uniques (app_id, day, humans) VALUES (?, ?, ?)
                  ON CONFLICT (app_id, day) DO UPDATE SET humans = excluded.humans`)
        .run(appId, new Date(dayStart).toISOString().slice(0, 10), this.uniqueHumans(appId, dayStart, dayStart + DAY_MS));
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

  // ---- maintenance --------------------------------------------------------

  /** Move WAL contents into the main file and truncate the WAL. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}
