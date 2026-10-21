// Scenarios: what each one does to the demo app, and which findings it must
// produce, how soon, and how soon they must resolve. The live run and the
// replay tests (apps/sim/test/scenarios.test.ts) run the same definitions.
// Times are from the scenario's start (shows) and from the end of its fault
// (resolves); they follow from Health's 5/15-minute windows ending 45 s
// before each 60 s run, and resolution after 3 clean runs (DECISIONS #40/#48).

import type { Faults } from "./model.js";
import { BOTS_BACKGROUND, BOTS_BURST, MIN, SEC, type AppKind } from "./traffic.js";
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
  | { start: { release?: string } };

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

/** May appear while the stack starts: no traffic in the window yet, or the app has not reconnected. */
export const STARTUP_ALLOWED: readonly string[] = [health("too_little_traffic"), "watchdog:reconnecting:"];
/** Never allowed: the run must not overload ingest or the SDK. */
export const NEVER_ALLOWED: readonly string[] = [health("data_incomplete")];

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
    forbid: [health("restart")],
    forbidMs: 3 * MIN,
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
    expect: [{ fingerprint: health("restart"), severity: "warning", summary: ["restarted 3 times in the last 15 min without a clean shutdown"], showWithinMs: 4 * MIN, resolveWithinMs: 20 * MIN }],
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
      { fingerprint: health("restart"), severity: "warning", summary: ["without a clean shutdown"], showWithinMs: 8 * MIN, resolveWithinMs: 20 * MIN },
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
 * overlap; restarts come one after another, then the long collapse.
 */
export const ALL: Record<AppKind, readonly { name: string; at: number }[]> = {
  node: [
    { name: "bots", at: 0 },
    { name: "dependency", at: WARMUP_MS },
    { name: "slow-route", at: WARMUP_MS },
    { name: "error-burst", at: WARMUP_MS },
    { name: "deploy", at: 13 * MIN },
    { name: "crash-loop", at: 17 * MIN },
    { name: "outage", at: 21 * MIN },
    { name: "collapse", at: 28 * MIN },
  ],
  next: [
    { name: "bots", at: 0 },
    { name: "error-burst", at: WARMUP_MS },
    { name: "deploy", at: 13 * MIN },
    { name: "crash-loop", at: 17 * MIN },
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
