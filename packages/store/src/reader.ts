// Read-only queries. Agent workers get only this class, over a read-only
// connection, so an agent cannot write. Every query about a monitored app takes
// an appId and filters by it; findings about Abigaail itself have app_id NULL
// and are read through systemFindings() only.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

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
  /** Consecutive successfully evaluated runs that did not emit it. */
  misses: number;
  first_seen: number;
  last_seen: number;
  resolved_at: number | null;
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

/** What a rollup or a window read reports per key. */
export type StatKind = "route" | "host" | "referrer" | "error" | "metric";

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
  /** Outbound calls that ended in error or timeout. */
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

/**
 * Traffic that matters (DECISIONS #37): not a known crawler or automation
 * client, and not flagged as a scanner probe or injection attempt. "unknown"
 * (no user agent, or transient withheld) counts.
 */
export const MATTERS_SQL = `(bot_class IS NULL OR bot_class NOT IN ('crawler', 'ai_crawler', 'automation'))
  AND NOT EXISTS (SELECT 1 FROM json_each(events.attrs, '$.flags') WHERE value IN ('scanner_path', 'injection_like'))`;

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
  "id, app_id, agent, fingerprint, signal, severity, state, summary, cause, action, evidence, hits, misses, first_seen, last_seen, resolved_at";
const APP_COLUMNS = "id, name, created_at, disabled_at, last_event_at";

function toFinding(row: Record<string, unknown>): Finding {
  return { ...(row as unknown as Finding), evidence: JSON.parse(String(row.evidence)) as Record<string, unknown> };
}

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
  lifecycle(appId: string, from: number, to: number): { ts: number; kind: string }[] {
    return this.db
      .prepare("SELECT ts, name AS kind FROM events WHERE app_id = ? AND type = 'lifecycle' AND ts >= ? AND ts < ? ORDER BY ts")
      .all(appId, from, to) as unknown as { ts: number; kind: string }[];
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
      if (r.outcome !== null && r.outcome !== "ok") row.failures++;
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

  /** Distinct visitor hashes of traffic that matters with ts in [from, to). */
  uniqueHumans(appId: string, from: number, to: number): number {
    const row = this.db
      .prepare(`SELECT count(DISTINCT visitor_hash) AS n FROM events
                WHERE app_id = ? AND type = 'request' AND ts >= ? AND ts < ? AND ${MATTERS_SQL}`)
      .get(appId, from, to);
    return Number((row as { n: number }).n);
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

  /** Latest runs of an agent, newest first. */
  recentRuns(agent: string, limit = 20): AgentRun[] {
    return this.db
      .prepare(`SELECT id, agent, started_at, finished_at, outcome, duration_ms, findings, error_class, apps_ok, apps_failed
                FROM agent_runs WHERE agent = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(agent, limit) as unknown as AgentRun[];
  }

  /** Finish time of the agent's last successful run. */
  lastOkRun(agent: string): number | undefined {
    const row = this.db
      .prepare("SELECT max(finished_at) AS t FROM agent_runs WHERE agent = ? AND outcome = 'ok'")
      .get(agent) as { t: number | null };
    return row.t ?? undefined;
  }

  /**
   * One status per app: red if an open critical finding has held for 2 runs;
   * amber for any other open critical or warning; grey for an open "unknown"
   * finding, or when the status agent has not completed a run within
   * `freshMs` (its view is stale); otherwise green.
   */
  appStatus(appId: string, opts: { now: number; statusAgent?: string; freshMs?: number }): { status: AppStatus; findings: Finding[] } {
    const open = this.openFindings(appId);
    const counted = open.filter((f) => f.severity !== "info");
    if (counted.some((f) => f.severity === "critical" && f.hits >= 2)) return { status: "red", findings: open };
    if (counted.some((f) => f.severity === "critical" || f.severity === "warning")) return { status: "amber", findings: open };
    const last = this.lastOkRun(opts.statusAgent ?? "health");
    const stale = last === undefined || opts.now - last > (opts.freshMs ?? 180_000);
    if (stale || counted.some((f) => f.severity === "unknown")) return { status: "grey", findings: open };
    return { status: "green", findings: open };
  }

  // ---- ingest and Abigaail itself --------------------------------------------

  /** Ingest refusals per status since `since`. appId '' = requests with an unknown key. */
  ingestRejections(appId: string, since: number): { status: number; n: number }[] {
    return this.db
      .prepare(`SELECT status, sum(n) AS n FROM ingest_rejections WHERE app_id = ? AND minute >= ?
                GROUP BY status ORDER BY status`)
      .all(appId, since) as unknown as { status: number; n: number }[];
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
