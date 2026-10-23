// Read-only queries. Agent workers get only this class, over a read-only
// connection, so an agent cannot write. Every query about a monitored app takes
// an appId and filters by it; findings about Abigaail itself have app_id NULL
// and are read through systemFindings() only.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { autoVacuumMode, freelistCount } from "./vacuum.js";

export interface App {
  id: string;
  name: string;
  created_at: number;
  disabled_at: number | null;
  last_event_at: number | null;
  /** Hosting region code from the app's latest boot, if it sent one. */
  region: string | null;
}

export interface Deploy {
  release: string;
  environment: string;
  first_seen: number;
  last_seen: number;
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
  parent_id: string | null;
}

export type Severity = "critical" | "warning" | "unknown" | "info";
export type FindingState = "open" | "resolved";

export interface Finding {
  id: number;
  app_id: string | null;
  agent: string;
  fingerprint: string;
  signal: string;
  severity: Severity;
  state: FindingState;
  summary: string;
  cause: string | null;
  action: string;
  evidence: Record<string, unknown>;
  /** Runs that emitted it since it (re)opened. */
  hits: number;
  /** Consecutive emissions at critical (misses in between neither count nor reset it). Red needs 2. */
  critical_streak: number;
  /** Consecutive successfully evaluated runs that did not emit it. */
  misses: number;
  /** "misses": resolves after N runs without it; "fact": on the first run without it. */
  resolves: "misses" | "fact";
  first_seen: number;
  last_seen: number;
  resolved_at: number | null;
  /** "not_observed": closed because Abigaail was down longer than the resolve window. */
  resolved_reason: "not_observed" | null;
}

export type RunOutcome = "ok" | "error" | "timeout" | "skipped";

export interface AgentRun {
  id: number;
  agent: string;
  started_at: number;
  finished_at: number;
  outcome: RunOutcome;
  duration_ms: number;
  findings: number;
  error_class: string | null;
  apps_ok: number;
  apps_failed: number;
}

export type AppStatus = "red" | "amber" | "grey" | "green";

/** What a rollup or a window read reports per key. "app" has one key, "*": all requests that matter. */
export type StatKind = "route" | "host" | "referrer" | "error" | "metric" | "app";

export interface StatRow {
  /** Route pattern, host, referrer domain, "ErrorType route" or metric name. */
  key: string;
  /** Unweighted count: requests, calls, errors or metric samples. */
  n: number;
  /** Requests weighted by 1 / sample_rate. Equal to n for other kinds. */
  weighted_n: number;
  status_5xx: number;
  status_4xx: number;
  status_401_403: number;
  /** Outbound calls that failed: error, timeout, or a 5xx answer. */
  failures: number;
  /** Percentiles of duration_ms (metric kind: of the value). Unweighted: sampling is uniform. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Distinct visitor hashes (route and referrer kinds). */
  uniques: number;
}

export interface HourlyStat extends StatRow {
  hour: number;
}

export const HOUR_MS = 3_600_000;

/** What retention deletes, by policy name (DECISIONS #87). "rollups" = hourly_route_stats + rollup_hours. */
export type RetentionName =
  | "events" | "rollups" | "daily_uniques" | "findings" | "agent_runs" | "ingest_rejections" | "db_size_samples" | "audit_log" | "alerts" | "sessions";

export interface RetentionPolicyRow {
  name: RetentionName;
  /** 0: deleted as soon as it expires by its own rule (sessions). */
  keep_days: number;
  min_days: number;
  updated_at: number;
  last_run_at: number | null;
  last_deleted: number | null;
}

/**
 * Traffic that matters (DECISIONS #37): not a known crawler or automation
 * client, and not flagged as a scanner probe or injection attempt. "unknown"
 * (no user agent, or transient withheld) counts.
 */
export const mattersSql = (t = "events") => `(${t}.bot_class IS NULL OR ${t}.bot_class NOT IN ('crawler', 'ai_crawler', 'automation'))
  AND NOT EXISTS (SELECT 1 FROM json_each(${t}.attrs, '$.flags') WHERE value IN ('scanner_path', 'injection_like'))`;
export const MATTERS_SQL = mattersSql();

/** An outbound call that failed: an error or timeout, or a 5xx answer. */
const FAILED_CALL_SQL = "(json_extract(o.attrs, '$.outcome') <> 'ok' OR o.status >= 500)";

/** How far before a window outbound calls are looked at when linking them to requests in it. */
const LINK_SLACK_MS = 60_000;

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

interface StatSource {
  key: string;
  status: number | null;
  v: number | null;
  sample_rate: number | null;
  visitor_hash: string | null;
  outcome: string | null;
}

const STAT_SQL: Record<StatKind, string> = {
  route: `SELECT route AS key, status, duration_ms AS v, sample_rate, visitor_hash, NULL AS outcome
          FROM events WHERE app_id = ? AND type = 'request' AND ts >= ? AND ts < ? AND ${MATTERS_SQL}`,
  app: `SELECT '*' AS key, status, duration_ms AS v, sample_rate, visitor_hash, NULL AS outcome
        FROM events WHERE app_id = ? AND type = 'request' AND ts >= ? AND ts < ? AND ${MATTERS_SQL}`,
  referrer: `SELECT json_extract(attrs, '$.referrer_domain') AS key, NULL AS status, NULL AS v, sample_rate,
                    visitor_hash, NULL AS outcome
             FROM events WHERE app_id = ? AND type = 'request' AND ts >= ? AND ts < ? AND ${MATTERS_SQL}
               AND json_extract(attrs, '$.referrer_domain') IS NOT NULL`,
  host: `SELECT host AS key, status, duration_ms AS v, NULL AS sample_rate, NULL AS visitor_hash,
                json_extract(attrs, '$.outcome') AS outcome
         FROM events WHERE app_id = ? AND type = 'outbound' AND ts >= ? AND ts < ?`,
  error: `SELECT name || ' ' || coalesce(route, '-') AS key, NULL AS status, NULL AS v, NULL AS sample_rate,
                 NULL AS visitor_hash, NULL AS outcome
          FROM events WHERE app_id = ? AND type = 'error' AND ts >= ? AND ts < ?`,
  metric: `SELECT name AS key, NULL AS status, value AS v, NULL AS sample_rate, NULL AS visitor_hash, NULL AS outcome
           FROM events WHERE app_id = ? AND type = 'metric' AND ts >= ? AND ts < ?`,
};

const STAT_COLUMNS = "key, n, weighted_n, status_5xx, status_4xx, status_401_403, failures, p50, p95, p99, uniques";
const FINDING_COLUMNS =
  "id, app_id, agent, fingerprint, signal, severity, state, summary, cause, action, evidence, hits, misses, critical_streak, resolves, first_seen, last_seen, resolved_at, resolved_reason";
export const APP_COLUMNS = "id, name, created_at, disabled_at, last_event_at, region";

function toFinding(row: Record<string, unknown>): Finding {
  return { ...(row as unknown as Finding), evidence: JSON.parse(String(row.evidence)) as Record<string, unknown> };
}

/**
 * Confirmed red: an open critical finding emitted at critical in 2 runs in a
 * row (AGENTS.md). The one rule for an app's status and for alerts, so a
 * single blip neither turns an app red nor notifies anyone.
 */
export function isRed(f: Pick<Finding, "state" | "severity" | "critical_streak">): boolean {
  return f.state === "open" && f.severity === "critical" && f.critical_streak >= 2;
}

/** A lifecycle event with what runtime_v1 adds (instance, startup, crash record). */
export interface LifecycleRow {
  event_id: string;
  ts: number;
  kind: string;
  release: string;
  instance: string | null;
  /** ready only: the boot it belongs to. */
  boot_id: string | null;
  startup_ms: number | null;
  heap_limit_mb: number | null;
  memory_limit_mb: number | null;
  prev_exit: { code: number; error_type?: string; frame?: { file: string; line: number; fn?: string }; heap_mb?: number; uptime_s?: number } | null;
}

/** Event-loop blocks charged to one route in one SDK interval (route null: nothing was in flight). */
export interface BlockRow {
  ts: number;
  route: string | null;
  count: number;
  total_ms: number;
  max_ms: number;
}

/** An uncaught error (handled: false). */
export interface FatalError {
  ts: number;
  error_type: string;
  frame: { file: string; line: number; fn?: string } | null;
}

/** One group of errors on the App page. */
export interface TopError {
  error_type: string;
  code: string | null;
  message: string | null;
  cause_type: string | null;
  cause_code: string | null;
  cause_message: string | null;
  /** Routes it happened on (patterns only; a route never contains a comma). */
  routes: string[];
  n: number;
  last: number;
}

/** Persisted alert dedup per (app, fingerprint). */
export interface AlertState {
  app_id: string | null;
  fingerprint: string;
  state: "firing" | "ok";
  sent: "firing" | "recovered" | null;
  finding_id: number | null;
  changed_at: number;
  fired_at: number | null;
  /** The finding's summary when the last firing message was sent; quoted by the recovery notice. */
  fired_summary: string | null;
  flaps: number;
}

export type DeliveryStatus = "pending" | "delivered" | "gave_up" | "suppressed";

/** One message to one channel, without its payload. */
export interface AlertDelivery {
  id: number;
  delivery_id: string;
  channel: string;
  kind: "alert" | "storm" | "test";
  created_at: number;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  last_code: number | null;
  finished_at: number | null;
}

/** Which finding a message carried, and how it went. */
export interface AlertItemRow {
  delivery: number;
  finding_id: number | null;
  fingerprint: string;
  change: "firing" | "recovered";
  channel: string;
  status: DeliveryStatus;
  created_at: number;
}

export interface AlertChannelRow {
  channel: string;
  label: string;
  updated_at: number;
  fail_streak: number;
  last_ok_at: number | null;
  last_failed_at: number | null;
  last_error: string | null;
}

const DELIVERY_COLUMNS =
  "id, delivery_id, channel, kind, created_at, status, attempts, next_attempt_at, last_attempt_at, last_error, last_code, finished_at";
const ALERT_STATE_COLUMNS = "app_id, fingerprint, state, sent, finding_id, changed_at, fired_at, fired_summary, flaps";

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export class StoreReader {
  private closed = false;

  constructor(protected readonly db: DatabaseSync) {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---- apps and events ------------------------------------------------------

  appByName(name: string): App | undefined {
    return this.db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE name = ?`).get(name) as App | undefined;
  }

  appById(id: string): App | undefined {
    return this.db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`).get(id) as App | undefined;
  }

  listApps(): App[] {
    return this.db.prepare(`SELECT ${APP_COLUMNS} FROM apps ORDER BY name`).all() as unknown as App[];
  }

  countEvents(appId: string, filter: { type?: string } = {}): number {
    const row = filter.type
      ? this.db.prepare("SELECT count(*) AS n FROM events WHERE app_id = ? AND type = ?").get(appId, filter.type)
      : this.db.prepare("SELECT count(*) AS n FROM events WHERE app_id = ?").get(appId);
    return Number((row as { n: number }).n);
  }

  /** Events of any type with ts in [from, to). */
  countEventsBetween(appId: string, from: number, to: number): number {
    const row = this.db.prepare("SELECT count(*) AS n FROM events WHERE app_id = ? AND ts >= ? AND ts < ?").get(appId, from, to);
    return Number((row as { n: number }).n);
  }

  recentEvents(appId: string, limit = 100): StoredEvent[] {
    return this.db
      .prepare(`
        SELECT event_id, ts, received_at, client_ts, type, release, environment, route, method,
               status, duration_ms, host, name, value, sample_rate, visitor_hash, browser,
               bot_class, country, city, attrs, parent_id
        FROM events WHERE app_id = ? ORDER BY ts DESC, event_id LIMIT ?`)
      .all(appId, limit) as unknown as StoredEvent[];
  }

  deploys(appId: string): Deploy[] {
    return this.db
      .prepare("SELECT release, environment, first_seen, last_seen FROM deploys WHERE app_id = ? ORDER BY first_seen")
      .all(appId) as unknown as Deploy[];
  }

  /** Lifecycle events (boot, heartbeat, shutdown) with ts in [from, to), oldest first. */
  lifecycle(appId: string, from: number, to: number): { ts: number; kind: string; release: string }[] {
    return this.db
      .prepare("SELECT ts, name AS kind, release FROM events WHERE app_id = ? AND type = 'lifecycle' AND ts >= ? AND ts < ? ORDER BY ts")
      .all(appId, from, to) as unknown as { ts: number; kind: string; release: string }[];
  }

  /** Release of the app's last event of any type before `ts`, if any. */
  releaseBefore(appId: string, ts: number): string | undefined {
    const row = this.db
      .prepare("SELECT release FROM events WHERE app_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1")
      .get(appId, ts) as { release: string } | undefined;
    return row?.release;
  }

  /** Time and release of the app's last event of any type before `ts`, if any. */
  lastEventBefore(appId: string, ts: number): { ts: number; release: string } | undefined {
    return this.db
      .prepare("SELECT ts, release FROM events WHERE app_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1")
      .get(appId, ts) as { ts: number; release: string } | undefined;
  }

  /** Startup times from ready events with ts in [from, to), newest first, at most `limit`. */
  startups(appId: string, from: number, to: number, limit: number): { ts: number; release: string; startup_ms: number }[] {
    return this.db
      .prepare(`SELECT ts, release, json_extract(attrs, '$.startup_ms') AS startup_ms FROM events
                WHERE app_id = ? AND type = 'lifecycle' AND name = 'ready' AND ts >= ? AND ts < ?
                  AND json_extract(attrs, '$.startup_ms') IS NOT NULL
                ORDER BY ts DESC LIMIT ?`)
      .all(appId, from, to, limit) as unknown as { ts: number; release: string; startup_ms: number }[];
  }

  /** Time of the app's oldest stored raw event, if any. */
  oldestEventTs(appId: string): number | undefined {
    const row = this.db.prepare("SELECT min(ts) AS t FROM events WHERE app_id = ?").get(appId) as { t: number | null };
    return row.t ?? undefined;
  }

  /** The latest boot, if any: when the running process started. */
  lastBoot(appId: string): { ts: number; release: string } | undefined {
    return this.db
      .prepare("SELECT ts, release FROM events WHERE app_id = ? AND type = 'lifecycle' AND name = 'boot' ORDER BY ts DESC LIMIT 1")
      .get(appId) as { ts: number; release: string } | undefined;
  }

  /** Lifecycle events with ts in [from, to), oldest first, with their runtime_v1 fields. */
  lifecycleDetail(appId: string, from: number, to: number): LifecycleRow[] {
    const rows = this.db
      .prepare(`SELECT event_id, ts, name AS kind, release, attrs FROM events
                WHERE app_id = ? AND type = 'lifecycle' AND ts >= ? AND ts < ? ORDER BY ts, event_id`)
      .all(appId, from, to) as unknown as { event_id: string; ts: number; kind: string; release: string; attrs: string | null }[];
    return rows.map((r) => {
      const a = (r.attrs ? JSON.parse(r.attrs) : {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      return {
        event_id: r.event_id,
        ts: r.ts,
        kind: r.kind,
        release: r.release,
        instance: typeof a.instance === "string" ? a.instance : null,
        boot_id: typeof a.boot_id === "string" ? a.boot_id : null,
        startup_ms: num(a.startup_ms),
        heap_limit_mb: num(a.heap_limit_mb),
        memory_limit_mb: num(a.memory_limit_mb),
        prev_exit: a.prev_exit && typeof a.prev_exit === "object" ? (a.prev_exit as LifecycleRow["prev_exit"]) : null,
      };
    });
  }

  /** Event-loop block events with ts in [from, to), oldest first. */
  blocks(appId: string, from: number, to: number): BlockRow[] {
    return this.db
      .prepare(`SELECT ts, route, CAST(coalesce(json_extract(attrs, '$.count'), 1) AS INTEGER) AS count,
                       value AS total_ms, duration_ms AS max_ms
                FROM events WHERE app_id = ? AND type = 'block' AND ts >= ? AND ts < ? ORDER BY ts`)
      .all(appId, from, to) as unknown as BlockRow[];
  }

  /** Uncaught errors (handled: false) with ts in [from, to), oldest first. */
  fatalErrors(appId: string, from: number, to: number): FatalError[] {
    const rows = this.db
      .prepare(`SELECT ts, name AS error_type, json_extract(attrs, '$.frames[0]') AS frame FROM events
                WHERE app_id = ? AND type = 'error' AND json_extract(attrs, '$.handled') = 0 AND ts >= ? AND ts < ? ORDER BY ts`)
      .all(appId, from, to) as unknown as { ts: number; error_type: string; frame: string | null }[];
    return rows.map((r) => ({ ts: r.ts, error_type: r.error_type, frame: r.frame ? (JSON.parse(r.frame) as FatalError["frame"]) : null }));
  }

  /** The latest lifecycle event, if any. */
  lastLifecycle(appId: string): { ts: number; kind: string } | undefined {
    return this.db
      .prepare("SELECT ts, name AS kind FROM events WHERE app_id = ? AND type = 'lifecycle' ORDER BY ts DESC LIMIT 1")
      .get(appId) as { ts: number; kind: string } | undefined;
  }

  // ---- windows and rollups -------------------------------------------------

  /**
   * Per-key stats over raw events with ts in [from, to). Agents use this only
   * for short windows; baselines come from the hourly rollup, which is built
   * with this same function.
   */
  statsFor(appId: string, kind: StatKind, from: number, to: number): StatRow[] {
    const acc = new Map<string, { row: StatRow; values: number[]; visitors: Set<string> }>();
    for (const r of this.db.prepare(STAT_SQL[kind]).iterate(appId, from, to) as Iterable<StatSource>) {
      let a = acc.get(r.key);
      if (!a) {
        a = {
          row: { key: r.key, n: 0, weighted_n: 0, status_5xx: 0, status_4xx: 0, status_401_403: 0, failures: 0, p50: null, p95: null, p99: null, uniques: 0 },
          values: [],
          visitors: new Set(),
        };
        acc.set(r.key, a);
      }
      const row = a.row;
      row.n++;
      row.weighted_n += 1 / (r.sample_rate ?? 1);
      if (r.status !== null) {
        if (r.status >= 500) row.status_5xx++;
        else if (r.status >= 400) row.status_4xx++;
        if (r.status === 401 || r.status === 403) row.status_401_403++;
      }
      // Same rule as FAILED_CALL_SQL: a dependency answering 5xx is failing too.
      if (r.outcome !== null && (r.outcome !== "ok" || (r.status ?? 0) >= 500)) row.failures++;
      if (r.v !== null) a.values.push(r.v);
      if (r.visitor_hash !== null) a.visitors.add(r.visitor_hash);
    }
    const out: StatRow[] = [];
    for (const { row, values, visitors } of acc.values()) {
      values.sort((x, y) => x - y);
      row.p50 = percentile(values, 50);
      row.p95 = percentile(values, 95);
      row.p99 = percentile(values, 99);
      row.uniques = visitors.size;
      out.push(row);
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** One metric's samples with ts in [from, to), oldest first. */
  metricSeries(appId: string, name: string, from: number, to: number): { ts: number; value: number }[] {
    return this.db
      .prepare("SELECT ts, value FROM events WHERE app_id = ? AND type = 'metric' AND name = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .all(appId, name, from, to) as unknown as { ts: number; value: number }[];
  }

  /**
   * Outbound calls with ts in [from, to), per host and the inbound route that
   * made them (via parent_id). route is null for calls with no stored parent
   * request (made outside a request, linking off, or the request was sampled out).
   */
  outboundByRoute(appId: string, from: number, to: number): { host: string; route: string | null; calls: number; failed: number }[] {
    return this.db
      .prepare(`
        SELECT o.host AS host, r.route AS route, count(*) AS calls, sum(CASE WHEN ${FAILED_CALL_SQL} THEN 1 ELSE 0 END) AS failed
        FROM events o LEFT JOIN events r ON r.app_id = o.app_id AND r.event_id = o.parent_id AND r.type = 'request'
        WHERE o.app_id = ? AND o.type = 'outbound' AND o.ts >= ? AND o.ts < ?
        GROUP BY o.host, r.route ORDER BY o.host, calls DESC`)
      .all(appId, from, to) as unknown as { host: string; route: string | null; calls: number; failed: number }[];
  }

  /** Whether any outbound event with ts in [from, to) carries a parent_id (linking is on for this app). */
  hasLinkedOutbound(appId: string, from: number, to: number): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM events WHERE app_id = ? AND type = 'outbound' AND ts >= ? AND ts < ? AND parent_id IS NOT NULL LIMIT 1")
      .get(appId, from, to);
  }

  /**
   * Failing requests (5xx, traffic that matters, ts in [from, to)) that made a
   * failed call to a host, per route and host. Driven from the outbound side,
   * so the join uses the events primary key.
   */
  failingRequestCauses(appId: string, from: number, to: number): { route: string; host: string; requests: number }[] {
    return this.db
      .prepare(`
        SELECT r.route AS route, o.host AS host, count(DISTINCT r.event_id) AS requests
        FROM events o JOIN events r ON r.app_id = o.app_id AND r.event_id = o.parent_id
        WHERE o.app_id = ? AND o.type = 'outbound' AND o.ts >= ? AND o.ts < ? AND ${FAILED_CALL_SQL}
          AND r.type = 'request' AND r.ts >= ? AND r.ts < ? AND r.status >= 500 AND ${mattersSql("r")}
        GROUP BY r.route, o.host`)
      .all(appId, from - LINK_SLACK_MS, to + LINK_SLACK_MS, from, to) as unknown as { route: string; host: string; requests: number }[];
  }

  /** Keys of one kind present in the rollup with hour in [from, to). */
  hourlyKeys(appId: string, kind: StatKind, from: number, to: number): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT key FROM hourly_route_stats WHERE app_id = ? AND kind = ? AND hour >= ? AND hour < ?")
      .all(appId, kind, from, to) as { key: string }[];
    return new Set(rows.map((r) => r.key));
  }

  /** First rolled-up hour of each key of one kind, for keys first seen at or after `since`. */
  firstSeenSince(appId: string, kind: StatKind, since: number): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT key, min(hour) AS first FROM hourly_route_stats WHERE app_id = ? AND kind = ?
                GROUP BY key HAVING min(hour) >= ?`)
      .all(appId, kind, since) as { key: string; first: number }[];
    return new Map(rows.map((r) => [r.key, r.first]));
  }

  /** Distinct visitor hashes of traffic that matters with ts in [from, to). */
  uniqueHumans(appId: string, from: number, to: number): number {
    const row = this.db
      .prepare(`SELECT count(DISTINCT visitor_hash) AS n FROM events
                WHERE app_id = ? AND type = 'request' AND ts >= ? AND ts < ? AND ${MATTERS_SQL}`)
      .get(appId, from, to);
    return Number((row as { n: number }).n);
  }

  /** Requests with ts in [from, to): traffic that matters vs bots and flagged probes (DECISIONS #37). */
  requestMix(appId: string, from: number, to: number): { matters: number; other: number } {
    const row = this.db
      .prepare(`SELECT count(*) AS n, coalesce(sum(CASE WHEN ${MATTERS_SQL} THEN 1 ELSE 0 END), 0) AS matters FROM events
                WHERE app_id = ? AND type = 'request' AND ts >= ? AND ts < ?`)
      .get(appId, from, to) as { n: number; matters: number };
    return { matters: Number(row.matters), other: Number(row.n) - Number(row.matters) };
  }

  /** Rollup rows of one kind for the given hours (optionally one key). */
  hourly(appId: string, kind: StatKind, hours: readonly number[], key?: string): HourlyStat[] {
    if (!hours.length) return [];
    const params: SQLInputValue[] = [appId, kind, ...hours];
    let sql = `SELECT hour, ${STAT_COLUMNS} FROM hourly_route_stats WHERE app_id = ? AND kind = ? AND hour IN (${placeholders(hours.length)})`;
    if (key !== undefined) {
      sql += " AND key = ?";
      params.push(key);
    }
    return this.db.prepare(`${sql} ORDER BY hour, key`).all(...params) as unknown as HourlyStat[];
  }

  /** Rollup rows of one kind with hour in [from, to). */
  hourlyRange(appId: string, kind: StatKind, from: number, to: number): HourlyStat[] {
    return this.db
      .prepare(`SELECT hour, ${STAT_COLUMNS} FROM hourly_route_stats
                WHERE app_id = ? AND kind = ? AND hour >= ? AND hour < ? ORDER BY hour, key`)
      .all(appId, kind, from, to) as unknown as HourlyStat[];
  }

  /**
   * Which of the given hours are rolled up, with the app's total event count in
   * each. A rolled hour with 0 events means no data, not zero traffic.
   */
  rolledHours(appId: string, hours: readonly number[]): Map<number, number> {
    if (!hours.length) return new Map();
    const rows = this.db
      .prepare(`SELECT hour, events FROM rollup_hours WHERE app_id = ? AND hour IN (${placeholders(hours.length)})`)
      .all(appId, ...hours) as unknown as { hour: number; events: number }[];
    return new Map(rows.map((r) => [r.hour, r.events]));
  }

  dailyUniques(appId: string, days: readonly string[]): Map<string, number> {
    if (!days.length) return new Map();
    const rows = this.db
      .prepare(`SELECT day, humans FROM daily_uniques WHERE app_id = ? AND day IN (${placeholders(days.length)})`)
      .all(appId, ...days) as unknown as { day: string; humans: number }[];
    return new Map(rows.map((r) => [r.day, r.humans]));
  }

  // ---- findings, runs, status ---------------------------------------------

  openFindings(appId: string): Finding[] {
    return (
      this.db
        .prepare(`SELECT ${FINDING_COLUMNS} FROM findings WHERE app_id = ? AND state = 'open' ORDER BY first_seen, id`)
        .all(appId) as Record<string, unknown>[]
    ).map(toFinding);
  }

  /** Open findings about Abigaail itself (app_id NULL). */
  systemFindings(): Finding[] {
    return (
      this.db
        .prepare(`SELECT ${FINDING_COLUMNS} FROM findings WHERE app_id IS NULL AND state = 'open' ORDER BY first_seen, id`)
        .all() as Record<string, unknown>[]
    ).map(toFinding);
  }

  /** All findings for an app, newest first, open or resolved. */
  findingHistory(appId: string, limit = 100): Finding[] {
    return (
      this.db
        .prepare(`SELECT ${FINDING_COLUMNS} FROM findings WHERE app_id = ? ORDER BY last_seen DESC, id DESC LIMIT ?`)
        .all(appId, limit) as Record<string, unknown>[]
    ).map(toFinding);
  }

  /** Findings of an app, open or resolved, seen at or after `since`, newest first. */
  findingsSince(appId: string, since: number, limit = 100): Finding[] {
    return (
      this.db
        .prepare(`SELECT ${FINDING_COLUMNS} FROM findings WHERE app_id = ? AND last_seen >= ? ORDER BY last_seen DESC, id DESC LIMIT ?`)
        .all(appId, since, limit) as Record<string, unknown>[]
    ).map(toFinding);
  }

  /** Every agent (and the rollup) that has logged a run, by name. */
  agentNames(): string[] {
    return (this.db.prepare("SELECT DISTINCT agent FROM agent_runs ORDER BY agent").all() as { agent: string }[]).map((r) => r.agent);
  }

  /** Latest runs of an agent, newest first. */
  recentRuns(agent: string, limit = 20): AgentRun[] {
    return this.db
      .prepare(`SELECT id, agent, started_at, finished_at, outcome, duration_ms, findings, error_class, apps_ok, apps_failed
                FROM agent_runs WHERE agent = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(agent, limit) as unknown as AgentRun[];
  }

  /** Runs of an agent started at or after `since`, counted per outcome. */
  runOutcomes(agent: string, since: number): Record<RunOutcome, number> {
    const out: Record<RunOutcome, number> = { ok: 0, error: 0, timeout: 0, skipped: 0 };
    const rows = this.db
      .prepare("SELECT outcome, count(*) AS n FROM agent_runs WHERE agent = ? AND started_at >= ? GROUP BY outcome")
      .all(agent, since) as { outcome: RunOutcome; n: number }[];
    for (const r of rows) out[r.outcome] = Number(r.n);
    return out;
  }

  /** Finish time of the last run of any agent that finished before `ts`. */
  lastRunBefore(ts: number): number | undefined {
    const row = this.db.prepare("SELECT max(finished_at) AS t FROM agent_runs WHERE finished_at < ?").get(ts) as { t: number | null };
    return row.t ?? undefined;
  }

  /** Finish time of the agent's last run of any outcome that finished at or before `ts`. */
  lastAgentRunBefore(agent: string, ts: number): number | undefined {
    const row = this.db
      .prepare("SELECT max(finished_at) AS t FROM agent_runs WHERE agent = ? AND finished_at <= ?")
      .get(agent, ts) as { t: number | null };
    return row.t ?? undefined;
  }

  /**
   * For a maintenance job (retention): when its first run that started at or
   * after `since` finished, and whether its latest run ended with work left.
   * Undefined until such a run has finished.
   */
  runsSince(agent: string, since: number): { firstFinishedAt: number; latestBehind: boolean } | undefined {
    const first = this.db
      .prepare("SELECT finished_at FROM agent_runs WHERE agent = ? AND started_at >= ? ORDER BY started_at, id LIMIT 1")
      .get(agent, since) as { finished_at: number } | undefined;
    if (!first) return undefined;
    const latest = this.db
      .prepare("SELECT behind FROM agent_runs WHERE agent = ? AND outcome <> 'skipped' ORDER BY started_at DESC, id DESC LIMIT 1")
      .get(agent) as { behind: number } | undefined;
    return { firstFinishedAt: first.finished_at, latestBehind: Number(latest?.behind ?? 0) !== 0 };
  }

  /** Finish time of the agent's last successful run. */
  lastOkRun(agent: string): number | undefined {
    const row = this.db
      .prepare("SELECT max(finished_at) AS t FROM agent_runs WHERE agent = ? AND outcome = 'ok'")
      .get(agent) as { t: number | null };
    return row.t ?? undefined;
  }

  /**
   * One status per app: red if an open critical finding has held for 2 runs (isRed);
   * amber for any other open critical or warning; grey for an open "unknown"
   * finding, or when the status agent has not completed a run within
   * `freshMs` (its view is stale); otherwise green.
   */
  appStatus(appId: string, opts: { now: number; statusAgent?: string; freshMs?: number }): { status: AppStatus; findings: Finding[] } {
    const open = this.openFindings(appId);
    const counted = open.filter((f) => f.severity !== "info");
    if (counted.some(isRed)) return { status: "red", findings: open };
    if (counted.some((f) => f.severity === "critical" || f.severity === "warning")) return { status: "amber", findings: open };
    const last = this.lastOkRun(opts.statusAgent ?? "health");
    const stale = last === undefined || opts.now - last > (opts.freshMs ?? 180_000);
    if (stale || counted.some((f) => f.severity === "unknown")) return { status: "grey", findings: open };
    return { status: "green", findings: open };
  }

  /** When the oldest resolved finding of an app (null: of Abigaail itself) was resolved. */
  oldestResolvedAt(appId: string | null): number | undefined {
    const row = (appId === null
      ? this.db.prepare("SELECT min(resolved_at) AS t FROM findings WHERE app_id IS NULL AND state = 'resolved'").get()
      : this.db.prepare("SELECT min(resolved_at) AS t FROM findings WHERE app_id = ? AND state = 'resolved'").get(appId)) as { t: number | null };
    return row.t ?? undefined;
  }

  /** The newest finding with this fingerprint, open or resolved (null: of Abigaail itself). */
  latestFinding(appId: string | null, fingerprint: string): Finding | undefined {
    const row = appId === null
      ? this.db.prepare(`SELECT ${FINDING_COLUMNS} FROM findings WHERE app_id IS NULL AND fingerprint = ? ORDER BY id DESC LIMIT 1`).get(fingerprint)
      : this.db.prepare(`SELECT ${FINDING_COLUMNS} FROM findings WHERE app_id = ? AND fingerprint = ? ORDER BY id DESC LIMIT 1`).get(appId, fingerprint);
    return row ? toFinding(row as Record<string, unknown>) : undefined;
  }

  // ---- alerts ----------------------------------------------------------------

  /** Alert states of one app (null: of Abigaail itself). Ok states that owe nothing expire with retention. */
  alertStates(appId: string | null): AlertState[] {
    return (appId === null
      ? this.db.prepare(`SELECT ${ALERT_STATE_COLUMNS} FROM alert_state WHERE app_id IS NULL`).all()
      : this.db.prepare(`SELECT ${ALERT_STATE_COLUMNS} FROM alert_state WHERE app_id = ?`).all(appId)) as unknown as AlertState[];
  }

  /** What the server has configured, as labels. */
  alertChannels(): AlertChannelRow[] {
    return this.db
      .prepare("SELECT channel, label, updated_at, fail_streak, last_ok_at, last_failed_at, last_error FROM alert_channels ORDER BY channel")
      .all() as unknown as AlertChannelRow[];
  }

  /** Recent messages, newest first, without their payload. */
  recentDeliveries(limit = 50): AlertDelivery[] {
    return this.db
      .prepare(`SELECT ${DELIVERY_COLUMNS} FROM alert_deliveries ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as unknown as AlertDelivery[];
  }

  /** Messages of one channel created at or after `since`. */
  deliveriesSince(channel: string, since: number): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM alert_deliveries WHERE channel = ? AND created_at >= ? AND kind <> 'test'")
      .get(channel, since) as { n: number };
    return Number(row.n);
  }

  /** What was sent about one app's findings since `since`, newest first (null: about Abigaail itself). */
  alertItems(appId: string | null, since: number): AlertItemRow[] {
    return (appId === null
      ? this.db.prepare(`SELECT i.delivery, i.finding_id, i.fingerprint, i.change, d.channel, d.status, d.created_at
                         FROM alert_items i JOIN alert_deliveries d ON d.id = i.delivery
                         WHERE i.app_id IS NULL AND d.created_at >= ? ORDER BY d.created_at DESC, d.id DESC`).all(since)
      : this.db.prepare(`SELECT i.delivery, i.finding_id, i.fingerprint, i.change, d.channel, d.status, d.created_at
                         FROM alert_items i JOIN alert_deliveries d ON d.id = i.delivery
                         WHERE i.app_id = ? AND d.created_at >= ? ORDER BY d.created_at DESC, d.id DESC`).all(appId, since)) as unknown as AlertItemRow[];
  }

  // ---- ingest and Abigaail itself --------------------------------------------

  /** The retention periods the server enforces, and its last run (written by the server only). */
  retentionPolicy(): RetentionPolicyRow[] {
    return this.db
      .prepare("SELECT name, keep_days, min_days, updated_at, last_run_at, last_deleted FROM retention_policy ORDER BY name")
      .all() as unknown as RetentionPolicyRow[];
  }

  /** PRAGMA auto_vacuum: 2 when freed pages can be returned to the filesystem (incremental). */
  autoVacuum(): number {
    return autoVacuumMode(this.db);
  }

  /** Pages freed by deletes but still part of the file. */
  freePages(): number {
    return freelistCount(this.db);
  }

  /** Ingest refusals per status since `since`. appId '' = requests with an unknown key. */
  ingestRejections(appId: string, since: number): { status: number; n: number }[] {
    return this.db
      .prepare(`SELECT status, sum(n) AS n FROM ingest_rejections WHERE app_id = ? AND minute >= ?
                GROUP BY status ORDER BY status`)
      .all(appId, since) as unknown as { status: number; n: number }[];
  }

  /** Text the server had to scrub again since `since` (count only). */
  scrubMismatches(appId: string, since: number): number {
    const row = this.db.prepare("SELECT coalesce(sum(n), 0) AS n FROM scrub_mismatches WHERE app_id = ? AND minute >= ?").get(appId, since) as { n: number };
    return Number(row.n);
  }

  /**
   * The app's outbound hosts: rolled-up hosts since `since` plus raw outbound
   * events of the last `recentMs`. The only hostnames a scrubbed message may keep.
   */
  outboundHosts(appId: string, since: number, now: number, recentMs: number): Set<string> {
    const hosts = this.hourlyKeys(appId, "host", since, now + 1);
    const raw = this.db
      .prepare("SELECT DISTINCT host FROM events WHERE app_id = ? AND type = 'outbound' AND ts >= ? AND host IS NOT NULL")
      .all(appId, now - recentMs) as { host: string }[];
    for (const r of raw) hosts.add(r.host);
    return hosts;
  }

  /**
   * The most frequent errors with ts in [from, to), grouped by type, code,
   * scrubbed message and cause code, so different causes are never merged.
   * The cause's type and message come from the latest error of the group
   * (SQLite takes bare columns from the max(ts) row); routes are listed.
   */
  topErrors(appId: string, from: number, to: number, limit = 10): TopError[] {
    const rows = this.db
      .prepare(`SELECT name AS error_type, json_extract(attrs, '$.code') AS code, json_extract(attrs, '$.message') AS message,
                       json_extract(attrs, '$.cause_code') AS cause_code, json_extract(attrs, '$.cause_type') AS cause_type,
                       json_extract(attrs, '$.cause_message') AS cause_message,
                       group_concat(DISTINCT route) AS routes, count(*) AS n, max(ts) AS last
                FROM events WHERE app_id = ? AND type = 'error' AND ts >= ? AND ts < ?
                GROUP BY name, code, message, cause_code ORDER BY n DESC, last DESC LIMIT ?`)
      .all(appId, from, to, limit) as unknown as (Omit<TopError, "routes"> & { routes: string | null })[];
    return rows.map((r) => ({ ...r, routes: r.routes ? r.routes.split(",").sort() : [] }));
  }

  /** Current database file size (excluding the WAL). */
  dbBytes(): number {
    const { page_count } = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const { page_size } = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    return page_count * page_size;
  }

  dbSizeSamples(since: number): { ts: number; bytes: number }[] {
    return this.db
      .prepare("SELECT ts, bytes FROM db_size_samples WHERE ts >= ? ORDER BY ts")
      .all(since) as unknown as { ts: number; bytes: number }[];
  }
}
