// Agent scheduler, in the server process (DECISIONS #11). Each agent run gets
// its own worker_thread with memory limits and a hard timeout; findings and
// the run log are written here, in the main thread, through the Store. The
// hourly rollup also runs here, as a maintenance step between ticks.

import { setImmediate as yieldToIngest } from "node:timers/promises";
import { Worker, type ResourceLimits } from "node:worker_threads";
import { HOUR_MS, type FindingInput, type RunInput, type Severity, type Store } from "@abigaail/store";
import { errorClass } from "./evaluate.js";
import { AGENTS } from "./registry.js";
import { EVAL_LAG_MS, FINDINGS, ROLLUP, SCHEDULE, WATCHDOG, windowEnd } from "./thresholds.js";
import type { AgentConfig, AgentSchedule, WorkerInput, WorkerResult } from "./types.js";

const MINUTE_MS = 60_000;
const SEVERITIES: readonly Severity[] = ["critical", "warning", "unknown", "info"];

export interface RunnerOptions {
  store: Store;
  dbPath: string;
  saltPath?: string;
  /** Agents to schedule. Default: the registry. */
  agents?: readonly (AgentSchedule & { timeoutMs: number })[];
  /** Worker script per agent. Default: the compiled worker.js next to this file. */
  workerUrl?: URL | ((agent: string) => URL);
  now?: () => number;
  /** Fixed messages only: agent names, outcomes and error class names. */
  log?: (msg: string) => void;
  resourceLimits?: ResourceLimits;
}

export interface RunReport {
  run: RunInput;
  findings: number;
  failed: WorkerResult["failed"];
}

/** Checks the shape of what a worker posted; anything malformed is an error run. */
function isResult(m: unknown): m is WorkerResult {
  const r = m as WorkerResult;
  return (
    !!r &&
    Array.isArray(r.findings) &&
    Array.isArray(r.evaluated) &&
    Array.isArray(r.failed) &&
    r.findings.every(
      (f) =>
        f &&
        typeof f.signal === "string" &&
        typeof f.subject === "string" &&
        SEVERITIES.includes(f.severity) &&
        typeof f.summary === "string" &&
        typeof f.action === "string" &&
        typeof f.evidence === "object" &&
        f.evidence !== null &&
        (f.app_id === null || typeof f.app_id === "string"),
    )
  );
}

export class Runner {
  readonly startedAt: number;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly agents: readonly (AgentSchedule & { timeoutMs: number })[];
  private readonly config: AgentConfig;
  private readonly running = new Map<string, Worker>();
  private readonly lastSlot = new Map<string, number>();
  private readonly lastOk = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rolledThrough: number | undefined;
  private maintaining = false;
  private stopped = false;

  constructor(private readonly opts: RunnerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((msg) => console.error(`[abigaail] ${msg}`));
    this.agents = opts.agents ?? AGENTS;
    this.startedAt = this.now();
    this.config = {
      dbPath: opts.dbPath,
      ...(opts.saltPath ? { saltPath: opts.saltPath } : {}),
      schedules: [
        ...this.agents.map(({ name, everyMs, timeoutMs }) => ({ name, everyMs, timeoutMs })),
        { name: "rollup", everyMs: SCHEDULE.rollup.everyMs },
      ],
      runnerStartedAt: this.startedAt,
    };
  }

  /** Tick at every minute boundary until stop(). Never keeps the process alive. */
  start(): void {
    const schedule = () => {
      if (this.stopped) return;
      const now = this.now();
      // One second past the minute, so minute-aligned windows have closed.
      const delay = MINUTE_MS - (now % MINUTE_MS) + 1_000;
      this.timer = setTimeout(() => {
        void this.tick();
        schedule();
      }, delay);
      this.timer.unref();
    };
    void this.tick();
    schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.all([...this.running.values()].map((w) => w.terminate()));
  }

  /** Whether the Watchdog completed a run recently; drives /healthz. */
  watchdogFresh(): boolean {
    const last = this.lastOk.get("watchdog") ?? this.startedAt;
    return this.now() - last <= WATCHDOG.healthzStaleMs;
  }

  /** Run the rollup, then every agent once, and wait for all of them. */
  async runOnce(): Promise<RunReport[]> {
    await this.maintain(true);
    return Promise.all(this.agents.map((a) => this.runAgent(a.name)));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    for (const a of this.agents) {
      // Due once per slot of its interval, aligned to the clock.
      const slot = Math.floor(now / a.everyMs);
      if (this.lastSlot.get(a.name) === slot) continue;
      this.lastSlot.set(a.name, slot);
      void this.runAgent(a.name);
    }
    await this.maintain(false);
  }

  /** Run one agent in a worker. Never throws; the outcome is logged to agent_runs. */
  runAgent(name: string): Promise<RunReport> {
    const spec = this.agents.find((a) => a.name === name);
    const startedAt = this.now();
    if (!spec) return Promise.resolve(this.record({ agent: name, started_at: startedAt, outcome: "error", error_class: "UnknownAgent" }));
    if (this.running.has(name)) {
      // The previous run is still going: never overlap an agent with itself.
      return Promise.resolve(this.record({ agent: name, started_at: startedAt, outcome: "skipped" }));
    }
    const input: WorkerInput = { agent: name, now: startedAt, windowEnd: windowEnd(startedAt), config: this.config };
    const url = typeof this.opts.workerUrl === "function"
      ? this.opts.workerUrl(name)
      : (this.opts.workerUrl ?? new URL("./worker.js", import.meta.url));

    let worker: Worker;
    try {
      worker = new Worker(url, {
        workerData: input,
        resourceLimits: this.opts.resourceLimits ?? { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        stdout: false,
        stderr: false,
      });
    } catch (err) {
      return Promise.resolve(this.record({ agent: name, started_at: startedAt, outcome: "error", error_class: errorClass(err) }));
    }
    this.running.set(name, worker);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: RunInput["outcome"], result?: WorkerResult, error_class?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(name);
        if (outcome !== "ok") void worker.terminate();
        resolve(this.record({ agent: name, started_at: startedAt, outcome, ...(error_class ? { error_class } : {}) }, result));
      };
      // A looping agent is terminated here; others are unaffected.
      const timer = setTimeout(() => finish("timeout", undefined, "Timeout"), spec.timeoutMs);
      worker.once("message", (m: unknown) => (isResult(m) ? finish("ok", m) : finish("error", undefined, "BadResult")));
      worker.once("error", (err) => finish("error", undefined, errorClass(err)));
      worker.once("exit", (code) => finish("error", undefined, code === 0 ? "NoResult" : "WorkerExit"));
    });
  }

  private record(
    partial: { agent: string; started_at: number; outcome: RunInput["outcome"]; error_class?: string },
    result?: WorkerResult,
  ): RunReport {
    const failed = result?.failed ?? [];
    const run: RunInput = {
      ...partial,
      finished_at: this.now(),
      apps_ok: result ? result.evaluated.filter((s) => s !== null).length : 0,
      apps_failed: failed.filter((f) => f.app_id !== null).length,
      ...(partial.error_class ? {} : failed.length ? { error_class: failed[0]!.error_class } : {}),
    };
    const findings: FindingInput[] = (result?.findings ?? []).map((f) => ({
      app_id: f.app_id,
      agent: partial.agent,
      // Built here, so an agent cannot produce a fingerprint of another shape.
      fingerprint: `${partial.agent}:${f.signal}:${f.subject}`,
      signal: f.signal,
      severity: f.severity,
      summary: f.summary,
      cause: f.cause ?? null,
      action: f.action,
      evidence: f.evidence,
    }));
    try {
      this.store.recordRun(run, findings, result?.evaluated ?? [], {
        cooldownMs: FINDINGS.cooldownMs,
        resolveAfter: FINDINGS.resolveAfter,
      });
      if (run.outcome === "ok") this.lastOk.set(run.agent, run.finished_at);
    } catch (err) {
      this.log(`agent ${run.agent}: could not record the run (${errorClass(err)})`);
    }
    if (run.outcome !== "ok" && run.outcome !== "skipped") this.log(`agent ${run.agent}: ${run.outcome} (${run.error_class})`);
    if (failed.length) {
      this.log(`agent ${run.agent}: ${failed.length} scope(s) failed (${[...new Set(failed.map((f) => f.error_class))].join(", ")})`);
    }
    return { run, findings: findings.length, failed };
  }

  /**
   * Hourly rollup. When a new hour closes (plus the evaluation lag), re-roll
   * the last few closed hours for late retries and sample the database size.
   * Then backfill missing hours in small slices, yielding to ingest between
   * hours. `full` keeps backfilling until nothing is missing (agents:once).
   */
  private async maintain(full: boolean): Promise<void> {
    if (this.maintaining || this.stopped) return;
    this.maintaining = true;
    try {
      const now = this.now();
      const closedEnd = Math.floor((now - EVAL_LAG_MS) / HOUR_MS) * HOUR_MS;
      const apps = this.store.listApps();
      if (this.rolledThrough !== closedEnd) {
        const startedAt = now;
        let error_class: string | undefined;
        for (const app of apps) {
          for (let k = 1; k <= ROLLUP.rerollHours; k++) {
            const hour = closedEnd - k * HOUR_MS;
            if (hour + HOUR_MS <= app.created_at) continue;
            try {
              this.store.rollupHour(app.id, hour);
            } catch (err) {
              error_class ??= errorClass(err);
            }
            await yieldToIngest();
          }
        }
        try {
          this.store.sampleDbSize();
        } catch (err) {
          error_class ??= errorClass(err);
        }
        this.rolledThrough = closedEnd;
        this.record({ agent: "rollup", started_at: startedAt, outcome: error_class ? "error" : "ok", ...(error_class ? { error_class } : {}) });
      }

      const oldest = closedEnd - ROLLUP.rerollHours * HOUR_MS;
      for (const app of apps) {
        const from = Math.max(Math.floor(app.created_at / HOUR_MS) * HOUR_MS, now - ROLLUP.backfillMs);
        let missing = this.store.missingHours(app.id, from, oldest);
        while (missing.length && !this.stopped) {
          for (const hour of missing.slice(0, ROLLUP.backfillPerTick)) {
            try {
              this.store.rollupHour(app.id, hour);
            } catch (err) {
              this.log(`rollup: backfill failed (${errorClass(err)})`);
              return;
            }
            await yieldToIngest();
          }
          if (!full) break;
          missing = this.store.missingHours(app.id, from, oldest);
        }
      }
    } catch (err) {
      this.log(`rollup: failed (${errorClass(err)})`);
    } finally {
      this.maintaining = false;
    }
  }
}
