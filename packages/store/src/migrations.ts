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
  // 3: agents. Outbound/error events link to their inbound request; findings,
  // agent runs, ingest rejection counts and the hourly baseline rollup.
  `
  ALTER TABLE events ADD COLUMN parent_id TEXT;

  CREATE TABLE findings (
    id          INTEGER PRIMARY KEY,
    -- NULL: a finding about Abigaail itself, not a monitored app.
    app_id      TEXT REFERENCES apps(id),
    agent       TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    signal      TEXT NOT NULL,
    severity    TEXT NOT NULL,
    state       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    cause       TEXT,
    action      TEXT NOT NULL,
    evidence    TEXT NOT NULL,
    -- Consecutive runs that emitted it / evaluated runs that did not.
    hits        INTEGER NOT NULL,
    misses      INTEGER NOT NULL,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE UNIQUE INDEX findings_open ON findings (coalesce(app_id, ''), fingerprint) WHERE state = 'open';
  CREATE INDEX findings_app_state ON findings (app_id, state, last_seen);
  CREATE INDEX findings_fingerprint ON findings (fingerprint, resolved_at);

  CREATE TABLE agent_runs (
    id          INTEGER PRIMARY KEY,
    agent       TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    outcome     TEXT NOT NULL,
    duration_ms REAL NOT NULL,
    findings    INTEGER NOT NULL,
    error_class TEXT,
    apps_ok     INTEGER NOT NULL,
    apps_failed INTEGER NOT NULL
  );
  CREATE INDEX agent_runs_agent ON agent_runs (agent, started_at);

  -- Ingest refusals per app and minute. app_id '' = unknown key (no app to name).
  CREATE TABLE ingest_rejections (
    app_id TEXT NOT NULL,
    minute INTEGER NOT NULL,
    status INTEGER NOT NULL,
    n      INTEGER NOT NULL,
    PRIMARY KEY (app_id, minute, status)
  );

  -- Hourly rollup: the only source of baselines. kind is route, host, referrer,
  -- error or metric; key is the route pattern, host, referrer domain,
  -- "ErrorType route" or metric name. Request rows count traffic that matters only.
  CREATE TABLE hourly_route_stats (
    app_id         TEXT NOT NULL REFERENCES apps(id),
    hour           INTEGER NOT NULL,
    kind           TEXT NOT NULL,
    key            TEXT NOT NULL,
    n              INTEGER NOT NULL,
    weighted_n     REAL NOT NULL,
    status_5xx     INTEGER NOT NULL,
    status_4xx     INTEGER NOT NULL,
    status_401_403 INTEGER NOT NULL,
    failures       INTEGER NOT NULL,
    p50            REAL,
    p95            REAL,
    p99            REAL,
    uniques        INTEGER NOT NULL,
    PRIMARY KEY (app_id, hour, kind, key)
  );
  CREATE INDEX hourly_route_stats_key ON hourly_route_stats (app_id, kind, key, hour);

  -- Hours already rolled up. events = all events of the app in that hour; a
  -- slot with 0 events is "no data" (app or Abigaail down), not "0 traffic".
  CREATE TABLE rollup_hours (
    app_id    TEXT NOT NULL REFERENCES apps(id),
    hour      INTEGER NOT NULL,
    events    INTEGER NOT NULL,
    rolled_at INTEGER NOT NULL,
    PRIMARY KEY (app_id, hour)
  );

  -- Database file size, sampled hourly, so growth is measured, not guessed.
  CREATE TABLE db_size_samples (
    ts    INTEGER PRIMARY KEY,
    bytes INTEGER NOT NULL
  );

  -- Unique humans per UTC day. Hourly uniques cannot be summed into a day, and
  -- the daily salt makes uniques across days impossible by design.
  CREATE TABLE daily_uniques (
    app_id TEXT NOT NULL REFERENCES apps(id),
    day    TEXT NOT NULL,
    humans INTEGER NOT NULL,
    PRIMARY KEY (app_id, day)
  );
  `,
];

/** user_version after which the store purges free space (see Store.purgeFreeSpace). */
export const MIGRATION_DROP_SALTS = 2;
