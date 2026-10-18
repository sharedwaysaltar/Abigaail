// Schema migrations, applied in order and tracked with PRAGMA user_version.
// Never edit a released migration: add a new one.
//
// Plain SQL with portable types, so a Postgres store can follow the same shape.

export const MIGRATIONS: readonly string[] = [
  // 1: apps, events, deploys, salts, audit_log.
  `
  CREATE TABLE apps (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    -- SHA-256 of the ingest key. The key itself is shown once and never stored.
    key_hash      TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    disabled_at   INTEGER,
    -- Server time of the last accepted batch, for the Watchdog's silence check.
    last_event_at INTEGER
  );

  -- Only named columns: there is no column that could hold a raw IP, user
  -- agent, URL, body or header. attrs holds type-specific allowlisted fields.
  CREATE TABLE events (
    app_id       TEXT NOT NULL REFERENCES apps(id),
    event_id     TEXT NOT NULL,
    -- Authoritative event time (server clock), derived at ingest.
    ts           INTEGER NOT NULL,
    received_at  INTEGER NOT NULL,
    client_ts    INTEGER NOT NULL,
    type         TEXT NOT NULL,
    release      TEXT NOT NULL,
    environment  TEXT NOT NULL,
    route        TEXT,
    method       TEXT,
    status       INTEGER,
    duration_ms  REAL,
    host         TEXT,
    -- metric name, error class name or lifecycle kind
    name         TEXT,
    value        REAL,
    sample_rate  REAL,
    visitor_hash TEXT,
    browser      TEXT,
    bot_class    TEXT,
    -- Reserved for geo at ingest (deferred).
    country      TEXT,
    city         TEXT,
    attrs        TEXT,
    PRIMARY KEY (app_id, event_id)
  ) WITHOUT ROWID;
  CREATE INDEX events_app_ts ON events (app_id, ts);
  CREATE INDEX events_app_type_ts ON events (app_id, type, ts);

  CREATE TABLE deploys (
    app_id      TEXT NOT NULL REFERENCES apps(id),
    release     TEXT NOT NULL,
    environment TEXT NOT NULL,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (app_id, release, environment)
  );

  -- Today's visitor-hash salt only (UTC day). Older rows are deleted.
  CREATE TABLE salts (
    day  TEXT PRIMARY KEY,
    salt BLOB NOT NULL
  );

  CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY,
    ts     INTEGER NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    app_id TEXT,
    detail TEXT
  );
  CREATE INDEX audit_log_ts ON audit_log (ts);
  `,
  // 2: the visitor-hash salt moves to its own file (apps/server/src/salt.ts),
  // so the database, its WAL and its backups never hold it. The store runs
  // VACUUM + checkpoint after this migration to erase old salt bytes.
  `
  DROP TABLE salts;
  `,
];

/** user_version after which the store purges free space (see Store.purgeFreeSpace). */
export const MIGRATION_DROP_SALTS = 2;
