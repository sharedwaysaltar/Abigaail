// The agent contract (SPEC "Multi-agent design"). Agents never call each other:
// they read the store, including other agents' findings, and return findings.

import type { App, Severity, StoreReader } from "@abigaail/store";

/** An agent's schedule, as the runner and the Watchdog see it. */
export interface AgentSchedule {
  name: string;
  everyMs: number;
  /** Absent for maintenance steps that do not run in a worker (the rollup). */
  timeoutMs?: number;
}

/** Plain data handed to a worker; must survive structured cloning. */
export interface AgentConfig {
  dbPath: string;
  /** Visitor-hash salt file. Agents may stat it, never read it. */
  saltPath?: string;
  /** Every scheduled agent and maintenance step, for the Watchdog. */
  schedules: AgentSchedule[];
  /** When the runner started, so a new install or a restart is not "stalled" at once. */
  runnerStartedAt: number;
  /** When any agent last finished before this start: the end of Abigaail's last up period. */
  lastRunBeforeStart: number | null;
}

export interface AgentContext {
  /** Read-only: an agent cannot write. */
  store: StoreReader;
  /** All apps, disabled ones included; each agent decides what applies. */
  apps: App[];
  now: number;
  /** Windows end here, EVAL_LAG_MS before now. */
  windowEnd: number;
  config: AgentConfig;
}

/** What an agent returns. The runner adds app_id, agent and the fingerprint. */
export interface AgentFinding {
  signal: string;
  /** Route, host, release or agent name; "" when the signal has no subject. */
  subject: string;
  severity: Severity;
  /** Plain English, with numbers. Never free text from the app. */
  summary: string;
  cause?: string;
  action: string;
  /** Numbers, windows and baselines behind the finding. */
  evidence: Record<string, unknown>;
  /**
   * A state, not a signal ("never sent an event", "stopped cleanly"): it
   * resolves on the first run where it is no longer true, not after 3 misses.
   */
  fact?: boolean;
}

export interface Agent extends AgentSchedule {
  timeoutMs: number;
  /** Findings for one app. Throwing marks only this app as failed. */
  forApp?(ctx: AgentContext, app: App): AgentFinding[];
  /** Findings about Abigaail itself (stored with app_id NULL). */
  forSystem?(ctx: AgentContext): AgentFinding[];
}

/** What a worker posts back to the runner. */
export interface WorkerResult {
  findings: (AgentFinding & { app_id: string | null })[];
  /** Scopes evaluated successfully: app ids, null = Abigaail itself. */
  evaluated: (string | null)[];
  /** Scopes that threw, with the error class name only. */
  failed: { app_id: string | null; error_class: string }[];
}

/** What the runner posts to a worker. */
export interface WorkerInput {
  agent: string;
  now: number;
  windowEnd: number;
  config: AgentConfig;
}
