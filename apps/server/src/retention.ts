// Retention (DECISIONS #87-#90): deletes data past its period, hourly, in the
// server's main thread (agent workers are read-only). It runs whether or not
// the agents are on. Every delete is a short transaction of at most
// RETENTION.batchRows rows followed by a yield, so ingest waits at most one
// batch; a run stops at its budget and, while work is left, the next run comes
// in RETENTION.catchUpMs instead of next hour.
//
// Deletion is per app_id, for every app_id that has rows (disabled apps and
// app_ids with no apps row included), then for rows without one. Raw events
// are rolled up before they are deleted, so baselines keep every hour.
// Deleted bytes are erased: secure_delete zeroes them, incremental vacuum
// returns freed pages to the filesystem and the WAL is truncated. Copies of
// moved rows that page splits leave in unused space of live pages are beyond
// secure_delete: a full VACUUM once a week, at the quietest hour, removes
// them, so deleted data is gone from the file within 7 days (DECISIONS #129).

import { existsSync } from "node:fs";
import { setTimeout as sleep, setImmediate as yieldToIngest } from "node:timers/promises";
import { AUTH } from "@abigaail/auth";
import { HOUR_MS, openAuthStore, type AuthStore, type RetentionName, type Store, type VacuumConversion } from "@abigaail/store";
import { errorClass } from "./agents/evaluate.js";
import { RETENTION, type RetentionDays, type RetentionPeriod } from "./agents/thresholds.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface RetentionOptions {
  store: Store;
  days: RetentionDays;
  /** Dashboard users' database. Pruned when it exists; never created here. */
  authDbPath?: string;
  now?: () => number;
  /** Measures the work budget. Default performance.now. */
  clock?: () => number;
  /** Fixed messages only: counts and error class names. */
  log?: (msg: string) => void;
  budgetMs?: number;
  batchRows?: number;
  /** Wait between attempts to truncate the WAL. Default RETENTION.checkpointRetryMs. */
  checkpointRetryMs?: number;
  /** Free disk for the weekly VACUUM's space check (tests). */
  freeBytes?: (dir: string) => number;
}

export interface RetentionReport {
  outcome: "ok" | "error" | "skipped";
  error_class?: string;
  /** Rows deleted per policy name. */
  deleted: Partial<Record<RetentionName, number>>;
  /** Work is left (budget spent, free pages left or the WAL not truncated): the next run is a catch-up run. */
  behind: boolean;
}

/** The policy rows the dashboard shows: every period, plus sessions (deleted when they expire). */
export function retentionPolicyRows(days: RetentionDays): { name: RetentionName; keep_days: number; min_days: number }[] {
  const rows = (Object.keys(RETENTION.periods) as RetentionPeriod[]).map((name) => ({
    name,
    keep_days: days[name],
    min_days: RETENTION.periods[name].minDays,
  }));
  return [...rows, { name: "sessions", keep_days: 0, min_days: 0 }];
}

const WEEK_MS = 7 * DAY_MS;
const BASELINE_WEEKS = 4;

/**
 * The hour (its start) for the next weekly VACUUM after one at `last`: of the
 * 24 hours whose run (at RETENTION.runAtMinute) falls in the last day before
 * last + 7 days, the one with the least traffic in the same hour of the past
 * 4 weeks, all apps combined (`traffic` per hour start); the earliest on a
 * tie. With a steady week it is the same hour every week; at the latest the
 * run is 7 days after the last one (DECISIONS #129).
 */
export function weeklyVacuumSlot(last: number, traffic: (hour: number) => number): number {
  const latest = Math.floor((last + WEEK_MS - RETENTION.runAtMinute * MINUTE_MS) / HOUR_MS) * HOUR_MS;
  let best = latest;
  let bestTraffic = Infinity;
  for (let h = latest - 23 * HOUR_MS; h <= latest; h += HOUR_MS) {
    let t = 0;
    for (let k = 1; k <= BASELINE_WEEKS; k++) t += traffic(h - k * WEEK_MS);
    if (t < bestTraffic) {
      best = h;
      bestTraffic = t;
    }
  }
  return best;
}

/** Start of the hour `days` before `now`: everything before it is past its period. */
export function hourCutoff(now: number, days: number): number {
  return Math.floor((now - days * DAY_MS) / HOUR_MS) * HOUR_MS;
}

/** When the next run is due after one that finished at `at`: soon while behind, else the next :30. */
export function nextRunAt(at: number, behind: boolean): number {
  if (behind) return at + RETENTION.catchUpMs;
  const slot = Math.floor(at / HOUR_MS) * HOUR_MS + RETENTION.runAtMinute * MINUTE_MS;
  return slot > at ? slot : slot + HOUR_MS;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * The one-time switch to incremental auto_vacuum (vacuum.ts), with its log
 * lines. Run at startup, before ingest listens and before any worker starts.
 */
export function convertForShrinking(
  target: Pick<Store | AuthStore, "convertToIncremental">,
  label: string,
  log: (msg: string) => void,
  opts: { freeBytes?: (dir: string) => number } = {},
): VacuumConversion | undefined {
  try {
    log(`${label}: checking whether the file can be converted to incremental vacuum`);
    const result = target.convertToIncremental(opts);
    if (result.status === "converted") {
      log(`${label}: converted to incremental vacuum in ${result.ms} ms (${mb(result.bytesBefore)} -> ${mb(result.bytesAfter)})`);
    } else if (result.status === "no_space") {
      log(`${label}: not converted to incremental vacuum: needs ${mb(result.needBytes)} free, ${mb(result.freeBytes)} free. ` +
        "Deleted data is still erased, but the file cannot shrink until there is room; restart after freeing space");
    }
    return result;
  } catch (err) {
    log(`${label}: conversion to incremental vacuum failed (${errorClass(err)}); running without it`);
    return undefined;
  }
}

type Checkpointable = { checkpoint(opts: { noWait?: boolean }): { busy: boolean } };

/**
 * Truncate a WAL without blocking the thread: a reader holding an old
 * snapshot (an agent mid-query, the dashboard) makes it busy, so it is tried
 * again a little later. Still busy after RETENTION.checkpointTries: throws
 * CheckpointBusy. Shared by retention and app:purge.
 */
export async function truncateWal(target: Checkpointable, what: string, retryMs: number = RETENTION.checkpointRetryMs): Promise<void> {
  for (let i = 0; i < RETENTION.checkpointTries; i++) {
    if (i) await sleep(retryMs);
    if (!target.checkpoint({ noWait: true }).busy) return;
  }
  throw Object.assign(new Error(`${what} could not be truncated: a reader holds an old snapshot`), { name: "CheckpointBusy" });
}

export class Retention {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly log: (msg: string) => void;
  private readonly budgetMs: number;
  private readonly batchRows: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<RetentionReport> | undefined;
  private stopped = false;
  private deadline = 0;

  constructor(private readonly opts: RetentionOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.clock = opts.clock ?? (() => performance.now());
    this.log = opts.log ?? ((msg) => console.error(`[abigaail] ${msg}`));
    this.budgetMs = opts.budgetMs ?? RETENTION.budgetMs;
    this.batchRows = opts.batchRows ?? RETENTION.batchRows;
    try {
      this.store.writeRetentionPolicy(retentionPolicyRows(opts.days));
      this.store.startVacuumClock();
    } catch (err) {
      this.log(`retention: could not record the policy (${errorClass(err)})`);
    }
  }

  /** Run now, then hourly at :30 (every 5 min while behind) until stop(). Never keeps the process alive. */
  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      const report = await this.runOnce();
      if (this.stopped) return;
      const at = this.now();
      this.timer = setTimeout(() => void loop(), Math.max(0, nextRunAt(at, report.behind) - at));
      this.timer.unref();
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One run, recorded in agent_runs as "retention". Never throws; never overlaps itself. */
  runOnce(): Promise<RetentionReport> {
    if (this.running) {
      const report: RetentionReport = { outcome: "skipped", deleted: {}, behind: true };
      this.record(this.now(), report);
      return Promise.resolve(report);
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<RetentionReport> {
    const startedAt = this.now();
    this.deadline = this.clock() + this.budgetMs;
    const { days } = this.opts;
    const deleted: Partial<Record<RetentionName, number>> = {};
    for (const name of Object.keys(RETENTION.periods) as RetentionPeriod[]) deleted[name] = 0;
    const add = (name: RetentionName, n: number) => (deleted[name] = (deleted[name] ?? 0) + n);
    let behind = false;
    let error_class: string | undefined;

    // Each step fails alone: an error in one table never stops the others.
    const step = async (name: string, fn: () => Promise<boolean>) => {
      if (this.stopped) return;
      try {
        if (await fn()) behind = true;
      } catch (err) {
        error_class ??= errorClass(err);
        this.log(`retention: ${name} failed (${errorClass(err)})`);
      }
    };
    const cut = (name: RetentionPeriod) => startedAt - days[name] * DAY_MS;

    // Raw events first: they carry the pseudonymous visitor hash.
    await step("events", async () => {
      const before = hourCutoff(startedAt, days.events);
      let left = false;
      for (const appId of this.store.retentionScopes("events")) {
        left = (await this.drain(() => this.store.deleteOldEvents(appId, before, this.batchRows).deleted, (n) => add("events", n))) || left;
      }
      return left;
    });
    await step("findings", () =>
      this.drainScopes([...this.store.retentionScopes("findings"), null], (s) => this.store.deleteExpired("findings", s, cut("findings"), this.batchRows), (n) => add("findings", n)));
    await step("ingest rejections", () =>
      this.drainScopes(this.store.retentionScopes("ingest_rejections"), (s) => this.store.deleteExpired("ingest_rejections", s, Math.floor(cut("ingest_rejections") / MINUTE_MS) * MINUTE_MS, this.batchRows), (n) => add("ingest_rejections", n)));
    await step("scrub mismatches", () =>
      this.drainScopes(this.store.retentionScopes("scrub_mismatches"), (s) => this.store.deleteExpired("scrub_mismatches", s, Math.floor(cut("ingest_rejections") / MINUTE_MS) * MINUTE_MS, this.batchRows), (n) => add("ingest_rejections", n)));
    await step("audit log", () =>
      this.drainScopes([...this.store.retentionScopes("audit_log"), null], (s) => this.store.deleteExpired("audit_log", s, cut("audit_log"), this.batchRows), (n) => add("audit_log", n)));
    await step("profiles", () =>
      this.drainScopes(this.store.retentionScopes("profiles"), (s) => this.store.deleteExpired("profiles", s, cut("profiles"), this.batchRows), (n) => add("profiles", n)));
    await step("alerts", async () => {
      const before = cut("alerts");
      const messages = await this.drain(() => this.store.deleteExpired("alert_deliveries", null, before, this.batchRows), (n) => add("alerts", n));
      const states = await this.drainScopes([...this.store.retentionScopes("alert_state"), null], (s) => this.store.deleteExpired("alert_state", s, before, this.batchRows), (n) => add("alerts", n));
      return messages || states;
    });
    await step("agent runs", () => this.drain(() => this.store.deleteExpired("agent_runs", null, cut("agent_runs"), this.batchRows), (n) => add("agent_runs", n)));
    await step("db size samples", () => this.drain(() => this.store.deleteExpired("db_size_samples", null, cut("db_size_samples"), this.batchRows), (n) => add("db_size_samples", n)));
    await step("daily uniques", () => {
      const day = new Date(Math.floor(cut("daily_uniques") / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
      return this.drainScopes(this.store.retentionScopes("daily_uniques"), (s) => this.store.deleteExpired("daily_uniques", s, day, this.batchRows), (n) => add("daily_uniques", n));
    });
    await step("rollups", () => {
      const before = hourCutoff(startedAt, days.rollups);
      const scopes = [...new Set([...this.store.retentionScopes("rollup_hours"), ...this.store.retentionScopes("hourly_route_stats")])];
      return this.drainScopes(scopes, (s) => this.store.deleteOldRollups(s, before, RETENTION.rollupHoursPerBatch), (n) => add("rollups", n));
    });
    await step("auth", async () => {
      const result = await this.pruneAuth(startedAt);
      if (result) {
        add("sessions", result.sessions);
        add("audit_log", result.audit);
      }
      return false;
    });

    // Return freed pages to the filesystem: at least one step even when the budget is spent.
    await step("vacuum", async () => {
      for (let first = true; ; first = false) {
        if (!first && this.clock() >= this.deadline) return true;
        if (this.store.incrementalVacuum(RETENTION.vacuumPages) === 0) return false;
        await yieldToIngest();
      }
    });
    // Truncate the WAL so no page image from before the deletes survives in it.
    await step("checkpoint", async () => {
      await this.truncateWal(this.store, "the WAL");
      return false;
    });
    // Once a week, at the quietest hour: a full VACUUM, so copies left in unused space are gone too.
    await step("weekly vacuum", async () => {
      await this.weeklyVacuum();
      return false;
    });
    if (error_class === "CheckpointBusy") behind = true;

    const report: RetentionReport = { outcome: error_class ? "error" : "ok", ...(error_class ? { error_class } : {}), deleted, behind };
    this.record(startedAt, report);
    const total = Object.values(deleted).reduce((a, b) => a + (b ?? 0), 0);
    if (total || behind) {
      const parts = Object.entries(deleted).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`);
      this.log(`retention: deleted ${total} rows${parts.length ? ` (${parts.join(", ")})` : ""}${behind ? "; work left, next run in 5 min" : ""}`);
    }
    return report;
  }

  /**
   * The weekly VACUUM, when its slot has come (weeklyVacuumSlot; at once when
   * overdue). It blocks ingest while it runs, in this thread: requests wait
   * and the SDK retries any that time out (event ids make that safe). Without
   * room (2.2 x the file free, #89) it is skipped, logged and reported by the
   * Watchdog (vacuum_skipped), and tried again at every run.
   */
  private async weeklyVacuum(): Promise<void> {
    const last = this.store.lastVacuumAt();
    if (last === undefined || this.now() < weeklyVacuumSlot(last, this.trafficByHour(last))) return;
    const noRoomBefore = this.store.vacuumNoRoomSince();
    const freeBytes = this.opts.freeBytes ? { freeBytes: this.opts.freeBytes } : {};
    const result = this.store.fullVacuum({ ...freeBytes, checkpoint: false });
    if (!result) return;
    if (result.status === "no_space") {
      if (noRoomBefore === undefined) {
        this.log(`retention: weekly VACUUM skipped: needs ${mb(result.needBytes)} free, ${mb(result.freeBytes)} free; tried again every hour`);
      }
      return;
    }
    this.log(`retention: weekly VACUUM in ${result.ms} ms (${mb(result.bytesBefore)} before)`);
    await this.truncateWal(this.store, "the WAL");
    const path = this.opts.authDbPath;
    if (path && existsSync(path)) {
      const auth = openAuthStore(path);
      try {
        const r = auth.fullVacuum({ ...freeBytes, checkpoint: false });
        if (r.status === "no_space") this.log("retention: weekly VACUUM of the auth database skipped: not enough free disk");
        else await this.truncateWal(auth, "the auth WAL");
      } finally {
        auth.close();
      }
    }
  }

  /**
   * Events per hour start, all apps combined (one app_id-scoped query per
   * app), for the 4 weeks before the hours weeklyVacuumSlot may choose.
   */
  private trafficByHour(last: number): (hour: number) => number {
    const latest = Math.floor((last + WEEK_MS) / HOUR_MS) * HOUR_MS;
    const hours: number[] = [];
    for (let h = latest - 24 * HOUR_MS; h <= latest; h += HOUR_MS) {
      for (let k = 1; k <= BASELINE_WEEKS; k++) hours.push(h - k * WEEK_MS);
    }
    const total = new Map<number, number>();
    for (const app of this.store.listApps()) {
      for (const [hour, n] of this.store.rolledHours(app.id, hours)) total.set(hour, (total.get(hour) ?? 0) + Number(n));
    }
    return (hour) => total.get(hour) ?? 0;
  }

  /** Repeat one bounded batch until it deletes nothing; yields between batches. True if the budget ran out first. */
  private async drain(batch: () => number, add: (n: number) => void): Promise<boolean> {
    for (;;) {
      if (this.stopped || this.clock() >= this.deadline) return true;
      const n = batch();
      add(n);
      if (n === 0) return false;
      await yieldToIngest();
    }
  }

  /** drain() for each scope in turn: an app_id, or null for rows without one. */
  private async drainScopes<S extends string | null>(scopes: readonly S[], batch: (scope: S) => number, add: (n: number) => void): Promise<boolean> {
    for (const scope of scopes) if (await this.drain(() => batch(scope), add)) return true;
    return false;
  }

  /** Prune the auth database if it exists (expired sessions, old failures and audit entries), then erase. */
  private async pruneAuth(now: number): Promise<{ sessions: number; audit: number } | undefined> {
    const path = this.opts.authDbPath;
    if (!path || !existsSync(path)) return undefined;
    const auth = openAuthStore(path, { now: () => now });
    try {
      const result = auth.prune({
        idleBefore: now - AUTH.sessionIdleMs,
        createdBefore: now - AUTH.sessionMaxMs,
        failuresBefore: now - DAY_MS,
        auditBefore: now - this.opts.days.audit_log * DAY_MS,
      });
      while (auth.incrementalVacuum(RETENTION.vacuumPages) > 0) await yieldToIngest();
      await this.truncateWal(auth, "the auth WAL");
      return result;
    } finally {
      auth.close();
    }
  }

  /** Truncate a WAL without blocking the thread (truncateWal). Busy 3 runs in a row raises agent_failing:retention. */
  private truncateWal(target: Checkpointable, what: string): Promise<void> {
    return truncateWal(target, what, this.opts.checkpointRetryMs);
  }

  private record(startedAt: number, report: RetentionReport): void {
    try {
      this.store.recordRun(
        {
          agent: "retention",
          started_at: startedAt,
          finished_at: this.now(),
          outcome: report.outcome,
          ...(report.error_class ? { error_class: report.error_class } : {}),
          apps_ok: 0,
          apps_failed: 0,
          behind: report.behind,
        },
        [],
        [],
      );
      if (report.outcome !== "skipped") this.store.recordRetention(startedAt, report.deleted);
    } catch (err) {
      this.log(`retention: could not record the run (${errorClass(err)})`);
    }
  }
}
