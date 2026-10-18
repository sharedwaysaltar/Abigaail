import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AbigaailEvent, Environment } from "@abigaail/schema";
import { generateIngestKey, hashIngestKey } from "./keys.js";
import { MIGRATION_DROP_SALTS, MIGRATIONS } from "./migrations.js";
import { toRow, type Derived } from "./rows.js";

export interface App {
  id: string;
  name: string;
  created_at: number;
  disabled_at: number | null;
  last_event_at: number | null;
}

export interface Deploy {
  release: string;
  environment: string;
  first_seen: number;
  last_seen: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  app_id: string | null;
  detail: string | null;
}

export interface StoredEvent {
  event_id: string;
  ts: number;
  received_at: number;
  client_ts: number;
  type: string;
  release: string;
  environment: string;
  route: string | null;
  method: string | null;
  status: number | null;
  duration_ms: number | null;
  host: string | null;
  name: string | null;
  value: number | null;
  sample_rate: number | null;
  visitor_hash: string | null;
  browser: string | null;
  bot_class: string | null;
  country: string | null;
  city: string | null;
  attrs: string | null;
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

const APP_COLUMNS = "id, name, created_at, disabled_at, last_event_at";

export function openStore(path: string, opts: StoreOptions = {}): Store {
  return new Store(path, opts);
}

/**
 * The only code that touches the database. Every method that reads or writes
 * monitored-app data takes an appId and filters by it.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(path: string, opts: StoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = opts.now ?? Date.now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      -- Overwrite deleted content instead of leaving it in free space.
      PRAGMA secure_delete = ON;
    `);
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
    const app: App = { id: randomUUID(), name, created_at: this.now(), disabled_at: null, last_event_at: null };
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

  appByName(name: string): App | undefined {
    return this.db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE name = ?`).get(name) as App | undefined;
  }

  listApps(): App[] {
    return this.db.prepare(`SELECT ${APP_COLUMNS} FROM apps ORDER BY name`).all() as unknown as App[];
  }

  listAudit(limit = 100): AuditEntry[] {
    return this.db
      .prepare("SELECT id, ts, actor, action, app_id, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as AuditEntry[];
  }

  // ---- events -------------------------------------------------------------

  /**
   * Append a validated batch in one transaction. Duplicate event_ids (retries)
   * are ignored and counted. Also records the deploy and the app's last-seen time.
   */
  insertBatch(appId: string, batch: IngestBatch): { inserted: number; duplicates: number } {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        app_id, event_id, ts, received_at, client_ts, type, release, environment,
        route, method, status, duration_ms, host, name, value, sample_rate,
        visitor_hash, browser, bot_class, attrs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    return this.tx(() => {
      let inserted = 0;
      for (const { event, derived } of batch.events) {
        const r = toRow(event, derived);
        const { changes } = insert.run(
          appId, r.event_id, r.ts, batch.receivedAt, r.client_ts, r.type, batch.release, batch.environment,
          r.route, r.method, r.status, r.duration_ms, r.host, r.name, r.value, r.sample_rate,
          r.visitor_hash, r.browser, r.bot_class, r.attrs,
        );
        inserted += Number(changes);
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
      return { inserted, duplicates: batch.events.length - inserted };
    });
  }

  countEvents(appId: string, filter: { type?: string } = {}): number {
    const row = filter.type
      ? this.db.prepare("SELECT count(*) AS n FROM events WHERE app_id = ? AND type = ?").get(appId, filter.type)
      : this.db.prepare("SELECT count(*) AS n FROM events WHERE app_id = ?").get(appId);
    return Number((row as { n: number }).n);
  }

  recentEvents(appId: string, limit = 100): StoredEvent[] {
    return this.db
      .prepare(`
        SELECT event_id, ts, received_at, client_ts, type, release, environment, route, method,
               status, duration_ms, host, name, value, sample_rate, visitor_hash, browser,
               bot_class, country, city, attrs
        FROM events WHERE app_id = ? ORDER BY ts DESC, event_id LIMIT ?`)
      .all(appId, limit) as unknown as StoredEvent[];
  }

  deploys(appId: string): Deploy[] {
    return this.db
      .prepare("SELECT release, environment, first_seen, last_seen FROM deploys WHERE app_id = ? ORDER BY first_seen")
      .all(appId) as unknown as Deploy[];
  }

  // ---- maintenance --------------------------------------------------------

  /** Move WAL contents into the main file and truncate the WAL. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
