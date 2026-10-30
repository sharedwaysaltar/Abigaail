// Scenarios: what each one does to the demo app, and which findings it must
// produce, how soon, and how soon they must resolve. The live run and the
// replay tests (apps/sim/test/scenarios.test.ts) run the same definitions.
// Times are from the scenario's start (shows) and from the end of its fault
// (resolves); they follow from Health's 5/15-minute windows ending 45 s
// before each 60 s run, and resolution after 3 clean runs (DECISIONS #40/#48).

import type { Faults } from "./model.js";
import { BOTS_BACKGROUND, BOTS_BURST, HOUR, MIN, SEC, type AppKind } from "./traffic.js";
import type { Severity } from "@abigaail/store";

export type Action =
  | { faults: Partial<Faults> }
  /** true/false, or a share of the usual human rate (0-1). */
  | { humans: boolean | number }
  | { bots: number }
  | { extra: { path: string; perMin: number }[] }
  /** SIGKILL: no shutdown event, queued events are lost. */
  | { kill: true }
  /** Clean stop (the app sends `shutdown`). */
  | { stop: true }
  | { start: { release?: string } }
  /** Restart the demo 2 s after it dies on its own (as systemd or pm2 would); our kill and stop are never restarted. */
  | { supervise: boolean };

export interface Expectation {
  /** agent:signal:subject, as the runner builds it. */
  fingerprint: string;
  severity: Severity;
  /** Words the summary must contain (when it reached its severity). */
  summary: readonly string[];
  showWithinMs: number;
  resolveWithinMs: number;
}

export interface Scenario {
  name: string;
  apps: readonly AppKind[];
  description: string;
  /** Offsets from the scenario's start. */
  steps: readonly { at: number; action: Action }[];
  /** When the fault ends (resolve deadlines count from here). */
  faultMs: number;
  /** Earliest start after the stack is up (the Watchdog calls a quiet app "reconnecting" for 8 min). */
  minStartMs?: number;
  expect: readonly Expectation[];
  /** Fingerprints that may also appear while it runs. */
  allowed?: readonly string[];
  /** Fingerprints that must not open within `forbidMs` of its start. */
  forbid?: readonly string[];
  forbidMs?: number;
  /** Compare stored traffic-that-matters with the human requests answered while it runs. */
  countCheck?: boolean;
}

const health = (signal: string, subject = "") => `health:${signal}:${subject}`;
const resilience = (signal: string, subject = "") => `resilience:${signal}:${subject}`;
const rollout = (release: string) => `rollout:release:${release}`;

/** Deploy sim-r2 with these faults (applied at its start), as a release that brings them would. */
const deployR2 = (faults: Partial<Faults> = {}): Scenario["steps"] => [
  { at: 0, action: { stop: true } },
  ...(Object.keys(faults).length ? [{ at: SEC, action: { faults } }] : []),
  { at: 2 * SEC, action: { start: { release: "sim-r2" } } },
];
/** Roll back (or move on) to sim-r1 at `at`, with the faults sim-r2 brought gone. */
const backToR1 = (at: number, faults: Partial<Faults> = {}): Scenario["steps"] => [
  { at, action: { stop: true } },
  ...(Object.keys(faults).length ? [{ at: at + SEC, action: { faults } }] : []),
  { at: at + 2 * SEC, action: { start: { release: "sim-r1" } } },
];

/** May appear while the stack starts: no traffic in the window yet, or the app has not reconnected. */
export const STARTUP_ALLOWED: readonly string[] = [health("too_little_traffic"), "watchdog:reconnecting:"];
/** Never allowed: the run must not overload ingest or the SDK. */
export const NEVER_ALLOWED: readonly string[] = [health("data_incomplete")];

/** How long the leak scenario leaks: past the warm-up and the 3 hours a leak needs. */
const LEAK_MS = 3 * HOUR + 45 * MIN;

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "bots",
    apps: ["node", "next"],
    description: "Crawlers, AI crawlers, automation and scanner/injection probes at 5× the human rate for 5 min. Kept out of health: no finding, and stored traffic that matters equals the human requests answered.",
    steps: [
      { at: 0, action: { bots: BOTS_BURST } },
      { at: 5 * MIN, action: { bots: BOTS_BACKGROUND } },
    ],
    faultMs: 5 * MIN,
    expect: [],
    countCheck: true,
  },
  {
    name: "dependency",
    apps: ["node"],
    description: "The local dependency behind /checkout answers 503 for 5 min.",
    steps: [
      { at: 0, action: { faults: { dependency: "failing" } } },
      { at: 5 * MIN, action: { faults: { dependency: "ok" } } },
    ],
    faultMs: 5 * MIN,
    expect: [{ fingerprint: health("dependency", "localhost"), severity: "critical", summary: ["localhost is failing", "so /checkout fails"], showWithinMs: 5 * MIN, resolveWithinMs: 21 * MIN }],
  },
  {
    name: "slow-route",
    apps: ["node"],
    description: "/search takes 1.2 s instead of ~60 ms for 5 min.",
    steps: [
      { at: 0, action: { faults: { slowSearch: true } } },
      { at: 5 * MIN, action: { faults: { slowSearch: false } } },
    ],
    faultMs: 5 * MIN,
    expect: [{ fingerprint: health("latency", "/search"), severity: "critical", summary: ["/search p95 is 1.2 s", "its usual"], showWithinMs: 4 * MIN, resolveWithinMs: 11 * MIN }],
  },
  {
    name: "error-burst",
    apps: ["node"],
    description: "/user/[id] throws a RangeError on half of its requests for 5 min.",
    steps: [
      { at: 0, action: { faults: { userErrorShare: 0.5 } } },
      { at: 5 * MIN, action: { faults: { userErrorShare: 0 } } },
    ],
    faultMs: 5 * MIN,
    expect: [
      { fingerprint: health("server_errors", "/user/[id]"), severity: "critical", summary: ["/user/[id] returns 5xx"], showWithinMs: 6 * MIN, resolveWithinMs: 21 * MIN },
      { fingerprint: health("new_error", "RangeError /user/[id]"), severity: "warning", summary: ["New error: RangeError on /user/[id]"], showWithinMs: 4 * MIN, resolveWithinMs: 21 * MIN },
    ],
  },
  {
    name: "error-burst",
    apps: ["next"],
    description: "Visitors hit /api/boom (always throws a TypeError) 15 times a minute for 5 min.",
    steps: [
      { at: 0, action: { extra: [{ path: "/api/boom", perMin: 15 }] } },
      { at: 5 * MIN, action: { extra: [] } },
    ],
    faultMs: 5 * MIN,
    expect: [
      { fingerprint: health("server_errors", "/api/boom"), severity: "critical", summary: ["/api/boom returns 5xx"], showWithinMs: 4 * MIN, resolveWithinMs: 21 * MIN },
      { fingerprint: health("new_error", "TypeError /api/boom"), severity: "warning", summary: ["TypeError on /api/boom"], showWithinMs: 4 * MIN, resolveWithinMs: 21 * MIN },
    ],
  },
  {
    name: "deploy",
    apps: ["node", "next"],
    description: "Clean restart on a new release (sim-r2).",
    steps: [{ at: 0, action: { stop: true } }, { at: 2 * SEC, action: { start: { release: "sim-r2" } } }],
    faultMs: 2 * SEC,
    expect: [{ fingerprint: health("deploy", "sim-r2"), severity: "info", summary: ["deployed release sim-r2 (was sim-r1)"], showWithinMs: 3 * MIN, resolveWithinMs: 19 * MIN }],
    forbid: [resilience("restart")],
    forbidMs: 3 * MIN,
  },
  {
    name: "bad-deploy",
    apps: ["node"],
    description: "Deploys sim-r2, whose /checkout throws a TypeError on 40% of requests (500); rolled back to sim-r1 after 25 min. Health reports the route at once; Rollout Safety recommends a rollback once it is sure, naming the changed lines the error comes from (the read-only GitHub link, answered by a fixture), and Health's findings fold into it.",
    steps: [...deployR2({ checkoutBug: 0.4 }), ...backToR1(25 * MIN, { checkoutBug: 0 })],
    faultMs: 25 * MIN + 2 * SEC,
    expect: [
      // The GitHub fixture (code.ts) changed applyDiscount's lines 133-136; the TypeError is thrown at line 135.
      { fingerprint: rollout("sim-r2"), severity: "critical", summary: ["Recommend rollback: release sim-r2 (replacing sim-r1)", "/checkout returns 5xx", "new error TypeError on /checkout", "Changed code involved: apps/demo-node/faults.mjs:135 (applyDiscount), lines 133-136"], showWithinMs: 16 * MIN, resolveWithinMs: 6 * MIN },
      { fingerprint: health("server_errors", "/checkout"), severity: "critical", summary: ["/checkout returns 5xx"], showWithinMs: 7 * MIN, resolveWithinMs: 21 * MIN },
      { fingerprint: health("new_error", "TypeError /checkout"), severity: "warning", summary: ["New error: TypeError on /checkout"], showWithinMs: 4 * MIN, resolveWithinMs: 21 * MIN },
      { fingerprint: health("deploy", "sim-r2"), severity: "info", summary: ["deployed release sim-r2 (was sim-r1)"], showWithinMs: 3 * MIN, resolveWithinMs: 19 * MIN },
      { fingerprint: health("deploy", "sim-r1"), severity: "info", summary: ["deployed release sim-r1 (was sim-r2)"], showWithinMs: 28 * MIN, resolveWithinMs: 19 * MIN },
    ],
  },
  {
    name: "slow-deploy",
    apps: ["node"],
    description: "Deploys sim-r2, whose /search takes 105 ms longer (about 2.3× its usual p95: Health's warning, not its critical); back to sim-r1 after 25 min. Rollout Safety says watch, not rollback: the route carries a quarter of the traffic and is not 2.5× as slow.",
    steps: [...deployR2({ searchExtraMs: 105 }), ...backToR1(25 * MIN, { searchExtraMs: 0 })],
    faultMs: 25 * MIN + 2 * SEC,
    expect: [
      { fingerprint: rollout("sim-r2"), severity: "warning", summary: ["Watch release sim-r2 (replacing sim-r1)", "/search p95 is"], showWithinMs: 14 * MIN, resolveWithinMs: 6 * MIN },
      { fingerprint: health("latency", "/search"), severity: "warning", summary: ["/search p95 is"], showWithinMs: 6 * MIN, resolveWithinMs: 11 * MIN },
      { fingerprint: health("deploy", "sim-r2"), severity: "info", summary: ["deployed release sim-r2 (was sim-r1)"], showWithinMs: 3 * MIN, resolveWithinMs: 19 * MIN },
      { fingerprint: health("deploy", "sim-r1"), severity: "info", summary: ["deployed release sim-r1 (was sim-r2)"], showWithinMs: 28 * MIN, resolveWithinMs: 19 * MIN },
    ],
  },
  {
    name: "clean-deploy",
    apps: ["node"],
    description: "Deploys sim-r2, which behaves exactly like sim-r1; the next deploy (sim-r1 again) comes 40 min later. Rollout Safety says it looks fine, never watch or rollback.",
    steps: [...deployR2(), ...backToR1(40 * MIN)],
    faultMs: 40 * MIN + 2 * SEC,
    expect: [
      { fingerprint: rollout("sim-r2"), severity: "info", summary: ["Release sim-r2 looks fine", "no route worse than"], showWithinMs: 36 * MIN, resolveWithinMs: 3 * MIN },
      { fingerprint: health("deploy", "sim-r2"), severity: "info", summary: ["deployed release sim-r2 (was sim-r1)"], showWithinMs: 3 * MIN, resolveWithinMs: 19 * MIN },
      { fingerprint: health("deploy", "sim-r1"), severity: "info", summary: ["deployed release sim-r1 (was sim-r2)"], showWithinMs: 43 * MIN, resolveWithinMs: 19 * MIN },
    ],
  },
  {
    name: "crash-deploy",
    apps: ["node"],
    description: "Deploys sim-r2, which throws an uncaught MigrationError 30 s after every start (a failed migration); a supervisor restarts it. Rolled back to sim-r1 after 12 min. Resilience reports the restarts at once; Rollout Safety recommends a rollback, and the restart finding folds into it.",
    steps: [
      { at: 0, action: { supervise: true } },
      ...deployR2({ crashAfterMs: 30_000 }),
      { at: 12 * MIN, action: { supervise: false } },
      ...backToR1(12 * MIN, { crashAfterMs: 0 }),
    ],
    faultMs: 12 * MIN + 2 * SEC,
    expect: [
      { fingerprint: rollout("sim-r2"), severity: "critical", summary: ["Recommend rollback: release sim-r2 (replacing sim-r1)", "crashed", "uncaught MigrationError at apps/demo-node/faults.mjs"], showWithinMs: 6 * MIN, resolveWithinMs: 6 * MIN },
      { fingerprint: resilience("restart"), severity: "warning", summary: ["without a clean shutdown", "uncaught MigrationError"], showWithinMs: 3 * MIN, resolveWithinMs: 20 * MIN },
      { fingerprint: health("deploy", "sim-r2"), severity: "info", summary: ["deployed release sim-r2 (was sim-r1)"], showWithinMs: 3 * MIN, resolveWithinMs: 19 * MIN },
      { fingerprint: health("deploy", "sim-r1"), severity: "info", summary: ["deployed release sim-r1 (was sim-r2)"], showWithinMs: 15 * MIN, resolveWithinMs: 19 * MIN },
    ],
    // The uncaught error is usually lost with the process (#31); if it arrives, Health calls it new.
    allowed: [health("new_error", "MigrationError -")],
  },
  {
    name: "crash-loop",
    apps: ["node", "next"],
    description: "Killed (SIGKILL) and restarted on the same release 3 times, 45 s apart.",
    steps: [
      { at: 0, action: { kill: true } },
      { at: 2 * SEC, action: { start: {} } },
      { at: 45 * SEC, action: { kill: true } },
      { at: 47 * SEC, action: { start: {} } },
      { at: 90 * SEC, action: { kill: true } },
      { at: 92 * SEC, action: { start: {} } },
    ],
    faultMs: 92 * SEC,
    expect: [
      {
        fingerprint: resilience("restart"),
        severity: "critical",
        summary: ["restarted 3 times in the last 15 min without a clean shutdown: a restart loop", "killed by a signal or the host"],
        showWithinMs: 5 * MIN,
        resolveWithinMs: 20 * MIN,
      },
    ],
  },
  {
    name: "outage",
    apps: ["node"],
    description: "Killed and left down for 5 min, then started again.",
    steps: [{ at: 0, action: { kill: true } }, { at: 5 * MIN, action: { start: {} } }],
    faultMs: 5 * MIN,
    minStartMs: 9 * MIN,
    expect: [
      { fingerprint: "watchdog:silent:", severity: "critical", summary: ["has been silent for"], showWithinMs: 5 * MIN, resolveWithinMs: 5 * MIN },
      { fingerprint: resilience("restart"), severity: "warning", summary: ["without a clean shutdown"], showWithinMs: 8 * MIN, resolveWithinMs: 20 * MIN },
    ],
  },
  {
    name: "blocking-route",
    apps: ["node"],
    description: "/docs runs 300 ms of synchronous work (renderDocs) on every request for 5 min, blocking the event loop.",
    steps: [
      { at: 0, action: { faults: { blockDocs: true } } },
      { at: 5 * MIN, action: { faults: { blockDocs: false } } },
    ],
    faultMs: 5 * MIN,
    expect: [{ fingerprint: resilience("loop_blocked", "/docs"), severity: "warning", summary: ["/docs blocked the event loop", "of the blocks in", "Mostly in renderDocs"], showWithinMs: 4 * MIN, resolveWithinMs: 20 * MIN }],
    // The route's own slowness and the lag are folded into the finding that names it.
    forbid: [health("latency", "/docs"), health("event_loop_lag")],
    forbidMs: 20 * MIN,
  },
  {
    name: "oom-loop",
    apps: ["node"],
    description: "The demo keeps 448 KB for good every second (about 3 min to 96 MB, whatever the traffic); at 96 MB of heap the process is killed (SIGKILL, like a container's OOM killer) and a supervisor restarts it, for 16 min.",
    steps: [
      { at: 0, action: { supervise: true } },
      { at: 0, action: { faults: { leakPerSecond: 448, oomKillMb: 96 } } },
      { at: 16 * MIN, action: { faults: { leakPerSecond: 0, oomKillMb: 0 } } },
      { at: 16 * MIN, action: { supervise: false } },
    ],
    faultMs: 16 * MIN,
    expect: [
      {
        fingerprint: resilience("restart"),
        severity: "critical",
        summary: ["a restart loop", "likely out of memory: its heap grew from", "allocated in rememberSearch"],
        showWithinMs: 13 * MIN,
        resolveWithinMs: 20 * MIN,
      },
    ],
  },
  {
    name: "leak",
    apps: ["node"],
    description: "Each /search keeps 64 KB for good for 3 h 45 min, then a clean restart. Long: run it on its own (not part of `run all`).",
    steps: [
      { at: 0, action: { faults: { leakPerRequest: 64 } } },
      { at: LEAK_MS, action: { faults: { leakPerRequest: 0 } } },
      { at: LEAK_MS, action: { stop: true } },
      { at: LEAK_MS + 2 * SEC, action: { start: {} } },
    ],
    faultMs: LEAK_MS + 2 * SEC,
    expect: [
      {
        fingerprint: resilience("leak", "heap"),
        severity: "warning",
        summary: ["heap floor after garbage collection rose from", "since it started", "Retained memory grew most at rememberSearch"],
        showWithinMs: 3 * HOUR + 35 * MIN,
        resolveWithinMs: 6 * MIN,
      },
    ],
  },
  {
    name: "collapse",
    apps: ["node"],
    description: "Human traffic stops for 16 min while the process, its heartbeats and the bots carry on.",
    steps: [{ at: 0, action: { humans: false } }, { at: 16 * MIN, action: { humans: true } }],
    faultMs: 16 * MIN,
    expect: [
      { fingerprint: health("traffic_collapse"), severity: "critical", summary: ["is up but traffic collapsed"], showWithinMs: 17 * MIN, resolveWithinMs: 7 * MIN },
      { fingerprint: health("too_little_traffic"), severity: "unknown", summary: ["Too little traffic to judge"], showWithinMs: 18 * MIN, resolveWithinMs: 4 * MIN },
    ],
  },
];

export function scenariosFor(app: AppKind): Scenario[] {
  return SCENARIOS.filter((s) => s.apps.includes(app));
}

export function scenario(app: AppKind, name: string): Scenario | undefined {
  return scenariosFor(app).find((s) => s.name === name);
}

/** Bots first (it doubles as the warm-up), then everything else. */
export const WARMUP_MS = 6 * MIN;

/**
 * `run all`: when each scenario starts. Scenarios whose findings differ
 * overlap; restarts come one after another, then the long collapse, then the
 * deploy (after it, everything runs on the new release, which Rollout Safety
 * would rightly blame). blocking-route, oom-loop, leak and the release
 * scenarios run on their own: a blocked loop slows every route, an OOM loop
 * overlaps every restart, a leak takes hours, and each release scenario
 * deploys a release of its own.
 */
export const ALL: Record<AppKind, readonly { name: string; at: number }[]> = {
  node: [
    { name: "bots", at: 0 },
    { name: "dependency", at: WARMUP_MS },
    { name: "slow-route", at: WARMUP_MS },
    { name: "error-burst", at: WARMUP_MS },
    { name: "crash-loop", at: 13 * MIN },
    { name: "outage", at: 17 * MIN },
    { name: "collapse", at: 24 * MIN },
    // Last: everything after a deploy runs on the new release, and Rollout Safety judges it.
    { name: "deploy", at: 47 * MIN },
  ],
  next: [
    { name: "bots", at: 0 },
    { name: "error-burst", at: WARMUP_MS },
    { name: "crash-loop", at: 13 * MIN },
    { name: "deploy", at: 17 * MIN },
  ],
};

/** A plan for one run: scenarios with absolute offsets from the stack being up. */
export function plan(app: AppKind, names: readonly string[]): { scenario: Scenario; at: number }[] {
  if (names.length === 1 && names[0] === "all") {
    return ALL[app].map(({ name, at }) => ({ scenario: scenario(app, name)!, at }));
  }
  return names.map((name, i) => {
    const s = scenario(app, name);
    if (!s) throw new Error(`no scenario "${name}" for demo-${app} (try: npm run sim -- list)`);
    if (i > 0) throw new Error("run one scenario, or all");
    // Background traffic first, so the scenario starts from a judged, normal state.
    return { scenario: s, at: s.name === "bots" ? 0 : Math.max(WARMUP_MS, s.minStartMs ?? 0) };
  });
}
