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
  // 4: how a finding resolves. 'misses': after N evaluated runs without it
  // (signals that can flap). 'fact': on the first evaluated run where it is no
  // longer true (states such as "never sent an event" or "stopped cleanly").
  `
  ALTER TABLE findings ADD COLUMN resolves TEXT NOT NULL DEFAULT 'misses';
  `,
  // 5: dashboard. apps.region is the hosting region code of the app's latest
  // boot (NULL: none sent). rollup_hours.version says which rollup shape
  // filled the hour; version 2 adds the app-wide 'app' kind, and older hours
  // count as missing so the backfill re-rolls them in place.
  `
  ALTER TABLE apps ADD COLUMN region TEXT;
  ALTER TABLE rollup_hours ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  `,
  // 6: why a finding resolved, when it was not the usual misses or fact rule.
  // 'not_observed': Abigaail was down longer than the agent's resolve window,
  // so nobody saw whether it was still true. Such a finding is never reopened
  // by the cooldown; if it is still true it starts fresh.
  `
  ALTER TABLE findings ADD COLUMN resolved_reason TEXT;
  `,
  // 7: retention. The policy the server enforces, written by the server and
  // only read by the dashboard, so the dashboard never shows a second copy of
  // the environment. keep_days 0 = deleted when expired (sessions). Agent
  // runs are deleted by finish time.
  `
  CREATE TABLE retention_policy (
    name         TEXT PRIMARY KEY,
    keep_days    INTEGER NOT NULL,
    min_days     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    last_run_at  INTEGER,
    last_deleted INTEGER
  );
  CREATE INDEX agent_runs_finished ON agent_runs (finished_at);
  `,
  // 8: whether a maintenance run (retention) ended with work left, so the
  // Watchdog can tell a job that is catching up from one that deletes nothing.
  `
  ALTER TABLE agent_runs ADD COLUMN behind INTEGER NOT NULL DEFAULT 0;
  `,
  // 9: alerts. findings.critical_streak counts consecutive emissions at
  // critical (red needs 2); open criticals start from their hits so no app
  // changes colour at upgrade. alert_state is the persisted dedup per (app,
  // fingerprint); alert_deliveries is the outbox, one row per message and
  // channel (a message may group several apps, so it is a system table);
  // alert_items says which findings of which app each message carried;
  // alert_channels holds what the server has configured, as labels only.
  `
  ALTER TABLE findings ADD COLUMN critical_streak INTEGER NOT NULL DEFAULT 0;
  UPDATE findings SET critical_streak = hits WHERE state = 'open' AND severity = 'critical';

  CREATE TABLE alert_state (
    -- NULL: a finding about Abigaail itself.
    app_id      TEXT,
    fingerprint TEXT NOT NULL,
    -- 'firing' (red) or 'ok', as last judged.
    state       TEXT NOT NULL,
    -- The last message sent: 'firing', 'recovered' or NULL (none yet).
    sent        TEXT,
    finding_id  INTEGER,
    changed_at  INTEGER NOT NULL,
    fired_at    INTEGER,
    -- State changes since the last message, reported with the next one.
    flaps       INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX alert_state_key ON alert_state (coalesce(app_id, ''), fingerprint);
  CREATE INDEX alert_state_app ON alert_state (app_id, state);

  CREATE TABLE alert_deliveries (
    id              INTEGER PRIMARY KEY,
    -- Random id sent to the receiver, so it can drop a repeat.
    delivery_id     TEXT NOT NULL UNIQUE,
    channel         TEXT NOT NULL,
    -- 'alert', 'storm' (the cap was reached) or 'test'.
    kind            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    -- The message (allowlisted finding fields only), kept so a restart can resume it.
    payload         TEXT NOT NULL,
    -- 'pending', 'delivered', 'gave_up' or 'suppressed' (over the cap, not sent).
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_attempt_at INTEGER,
    -- Error class and HTTP/SMTP status code only, never a message.
    last_error      TEXT,
    last_code       INTEGER,
    finished_at     INTEGER
  );
  CREATE INDEX alert_deliveries_channel ON alert_deliveries (channel, created_at);
  CREATE INDEX alert_deliveries_status ON alert_deliveries (status, channel);
  CREATE INDEX alert_deliveries_created ON alert_deliveries (created_at);

  CREATE TABLE alert_items (
    delivery INTEGER NOT NULL REFERENCES alert_deliveries(id) ON DELETE CASCADE,
    app_id      TEXT,
    finding_id  INTEGER,
    fingerprint TEXT NOT NULL,
    -- 'firing' or 'recovered'.
    change      TEXT NOT NULL
  );
  CREATE INDEX alert_items_app ON alert_items (app_id, finding_id);
  CREATE INDEX alert_items_delivery ON alert_items (delivery);

  CREATE TABLE alert_channels (
    channel        TEXT PRIMARY KEY,
    -- 'webhook (json, hooks.example.com)' or 'email to 2 recipients': never a URL path, secret or address.
    label          TEXT NOT NULL,
    updated_at     INTEGER NOT NULL,
    -- Consecutive failed attempts; the Watchdog's alert_delivery_failed reads it.
    fail_streak    INTEGER NOT NULL DEFAULT 0,
    last_ok_at     INTEGER,
    last_failed_at INTEGER,
    last_error     TEXT
  );
  `,
  // 10: the finding's summary when its last "firing" message went out, so the
  // recovery notice quotes what was wrong rather than the finding's last words.
  `
  ALTER TABLE alert_state ADD COLUMN fired_summary TEXT;
  `,
  // 11: scrubbed text the server had to scrub again (the SDK's text was not
  // a fixed point of the server's rules: an older SDK, or tampering), counted
  // per app and minute like ingest refusals. Never the text itself.
  `
  CREATE TABLE scrub_mismatches (
    app_id TEXT NOT NULL,
    minute INTEGER NOT NULL,
    n      INTEGER NOT NULL,
    PRIMARY KEY (app_id, minute)
  );
  `,
];

/** Shape of the hourly rollup; hours rolled with an older version are rolled again. */
export const ROLLUP_VERSION = 2;

/** user_version after which the store purges free space (see Store.purgeFreeSpace). */
export const MIGRATION_DROP_SALTS = 2;
