// Judges a run from the store: did each expected finding open with its
// severity and summary in time, and resolve in time; did anything else open.
// The live run polls this every few seconds over a read-only connection; the
// replay tests feed it after every simulated agent run.

import { existsSync, readFileSync } from "node:fs";
import { isRed, type Finding, type Severity, type StoreReader } from "@abigaail/store";
import { PATCH_MARKER, SIM_GITHUB_TOKEN } from "./code.js";
import { NEVER_ALLOWED, STARTUP_ALLOWED, type Expectation, type Scenario } from "./scenarios.js";

const RANK: Record<Severity, number> = { info: 0, unknown: 1, warning: 2, critical: 3 };

/**
 * At least as severe, within the same family (info and unknown must match
 * exactly). A critical counts only once confirmed red (2 runs in a row at
 * critical, isRed): that is when the app turns red and an alert goes out.
 */
function reaches(actual: Emission, expected: Severity): boolean {
  if (expected === "info" || expected === "unknown") return actual.severity === expected;
  if (expected === "critical") return isRed({ state: "open", severity: actual.severity, critical_streak: actual.critical_streak });
  return RANK[actual.severity] >= RANK[expected] && actual.severity !== "unknown";
}

export interface Tracked {
  scenario: string;
  exp: Expectation;
  /** Absolute times. */
  startAt: number;
  faultEndAt: number;
}

export interface Timeline {
  runStart: number;
  items: Tracked[];
  allowed: string[];
  forbids: { scenario: string; fingerprint: string; from: number; to: number }[];
  countWindows: { scenario: string; from: number; to: number }[];
}

export function timeline(runStart: number, planned: readonly { scenario: Scenario; at: number }[]): Timeline {
  const t: Timeline = { runStart, items: [], allowed: [...STARTUP_ALLOWED], forbids: [], countWindows: [] };
  for (const { scenario: s, at } of planned) {
    const startAt = runStart + at;
    for (const exp of s.expect) t.items.push({ scenario: s.name, exp, startAt, faultEndAt: startAt + s.faultMs });
    t.allowed.push(...(s.allowed ?? []));
    for (const fingerprint of s.forbid ?? []) t.forbids.push({ scenario: s.name, fingerprint, from: startAt, to: startAt + (s.forbidMs ?? s.faultMs) });
    if (s.countCheck) t.countWindows.push({ scenario: s.name, from: startAt + 60_000, to: startAt + s.faultMs - 15_000 });
  }
  return t;
}

export interface Emission {
  severity: Severity;
  summary: string;
  cause: string | null;
  critical_streak: number;
}

interface Seen {
  finding: Finding;
  /** Each distinct emission observed (by last_seen): its severity, summary and cause. */
  emissions: Map<number, Emission>;
}

const MAX_EMISSIONS = 500;

export interface Result {
  scenario: string;
  fingerprint: string;
  severity: Severity;
  status: "waiting" | "shown" | "pass" | "fail";
  detail: string;
  showMs?: number;
  resolveMs?: number;
}

export interface Problem {
  kind: "unexpected" | "forbidden" | "count" | "limits" | "privacy";
  detail: string;
}

/** Info that is reported, never judged: Usage's findings, and Rollout's verdict while it is info. */
const noted = (f: Finding) => (f.agent === "usage" || f.agent === "rollout") && f.severity === "info";

export class Tracker {
  private readonly seen = new Map<number, Seen>();

  constructor(readonly t: Timeline) {}

  /** Record the findings of the app seen since the run started (any state). */
  observe(findings: readonly Finding[]): void {
    for (const f of findings) {
      if (f.first_seen < this.t.runStart && f.state !== "open") continue;
      let s = this.seen.get(f.id);
      if (!s) this.seen.set(f.id, (s = { finding: f, emissions: new Map() }));
      s.finding = f;
      if (s.emissions.size < MAX_EMISSIONS) s.emissions.set(f.last_seen, { severity: f.severity, summary: f.summary, cause: f.cause, critical_streak: f.critical_streak });
    }
  }

  private rows(fingerprint: string): Seen[] {
    return [...this.seen.values()].filter((s) => s.finding.fingerprint === fingerprint).sort((a, b) => a.finding.first_seen - b.finding.first_seen);
  }

  /** Everything a fingerprint was seen saying, oldest first. */
  emissionsOf(fingerprint: string): (Emission & { at: number })[] {
    return this.rows(fingerprint)
      .flatMap((s) => [...s.emissions].map(([at, e]) => ({ at, ...e })))
      .sort((a, b) => a.at - b.at);
  }

  /** The latest fault end among scenarios expecting this fingerprint: it may resolve only after all of them. */
  private resolveDeadline(fingerprint: string): number {
    return Math.max(...this.t.items.filter((i) => i.exp.fingerprint === fingerprint).map((i) => i.faultEndAt + i.exp.resolveWithinMs));
  }

  results(now: number): Result[] {
    return this.t.items.map((item) => {
      const { exp } = item;
      const base = { scenario: item.scenario, fingerprint: exp.fingerprint, severity: exp.severity };
      const showBy = item.startAt + exp.showWithinMs;
      const resolveBy = this.resolveDeadline(exp.fingerprint);
      // Only what was emitted after the scenario started counts (a finding may reopen within the cooldown).
      const emitted = this.rows(exp.fingerprint)
        .flatMap((s) => [...s.emissions].map(([at, e]) => ({ at, ...e })))
        .filter((e) => e.at >= item.startAt)
        .sort((a, b) => a.at - b.at);
      const hit = emitted.find((e) => reaches(e, exp.severity));
      if (!hit) {
        const other = emitted[0] ? ` (seen as ${emitted[0].severity})` : "";
        return now > showBy ? { ...base, status: "fail", detail: `not ${exp.severity} within ${mins(exp.showWithinMs)}${other}` } : { ...base, status: "waiting", detail: `waiting${other}` };
      }
      const showMs = hit.at - item.startAt;
      if (hit.at > showBy) return { ...base, status: "fail", showMs, detail: `${exp.severity} only after ${mins(showMs)} (limit ${mins(exp.showWithinMs)})` };
      const last = this.rows(exp.fingerprint).at(-1)!.finding;
      // Words are checked against the summary when it was first confirmed at its severity, or any
      // summary seen while open after that: it may still grow ("restarted once", then "3 times"),
      // and during recovery it may lose them ("13 of 48 calls …"), which is no failure.
      const confirmed = emitted.filter((e) => e.at >= hit.at);
      if (!exp.summary.every((w) => confirmed.some((e) => e.summary.includes(w)))) {
        const detail = `summary lacks "${exp.summary.join('", "')}"; when confirmed it read: ${hit.summary}`;
        return last.state === "open" && now <= resolveBy ? { ...base, status: "shown", showMs, detail } : { ...base, status: "fail", showMs, detail };
      }
      const banned = confirmed.find((e) => exp.summaryNot?.some((w) => e.summary.includes(w)));
      if (banned) return { ...base, status: "fail", showMs, detail: `summary must not say "${exp.summaryNot!.join('", "')}"; it read: ${banned.summary}` };
      if (last.state === "open") {
        return now > resolveBy ? { ...base, status: "fail", showMs, detail: `still open ${mins(now - item.faultEndAt)} after the fault ended` } : { ...base, status: "shown", showMs, detail: "shown; waiting to resolve" };
      }
      const resolveMs = Math.max(0, last.resolved_at! - item.faultEndAt);
      if (last.resolved_at! > resolveBy) return { ...base, status: "fail", showMs, resolveMs, detail: `resolved only after ${mins(resolveMs)}` };
      return { ...base, status: "pass", showMs, resolveMs, detail: "ok" };
    });
  }

  /**
   * Findings nothing in the plan accounts for, and forbidden ones. Usage's
   * info findings, and Rollout Safety's info verdicts on a release ("too
   * little traffic yet", "looks fine"), are only noted; a Rollout warning or
   * critical (watch, rollback) the plan does not expect at that level fails.
   */
  problems(): Problem[] {
    const expected = new Set([...this.t.items.map((i) => i.exp.fingerprint), ...this.t.allowed]);
    const alarming = new Set(this.t.items.filter((i) => i.exp.severity === "warning" || i.exp.severity === "critical").map((i) => i.exp.fingerprint));
    const out: Problem[] = [];
    for (const { finding: f, emissions } of this.seen.values()) {
      if (f.first_seen < this.t.runStart) continue;
      const never = NEVER_ALLOWED.includes(f.fingerprint);
      if (never || (!expected.has(f.fingerprint) && !noted(f))) {
        out.push({ kind: "unexpected", detail: `${f.fingerprint} (${f.severity}): ${f.summary}` });
      } else if (f.agent === "rollout" && !alarming.has(f.fingerprint)) {
        const alarm = [...emissions.values()].find((e) => e.severity === "warning" || e.severity === "critical");
        if (alarm) out.push({ kind: "unexpected", detail: `${f.fingerprint} (${alarm.severity}): ${alarm.summary}` });
      }
      for (const fb of this.t.forbids) {
        if (f.fingerprint === fb.fingerprint && f.first_seen >= fb.from && f.first_seen <= fb.to) {
          out.push({ kind: "forbidden", detail: `${f.fingerprint} opened during ${fb.scenario}: ${f.summary}` });
        }
      }
    }
    return out;
  }

  /** Usage's info findings and Rollout's info verdicts, reported but never a failure. */
  notes(): string[] {
    return [...this.seen.values()].filter((s) => noted(s.finding) && s.finding.first_seen >= this.t.runStart).map((s) => `${s.finding.fingerprint}: ${s.finding.summary}`);
  }

  /** Every expectation passed or failed (nothing is still waiting or open). */
  settled(now: number): boolean {
    return this.results(now).every((r) => r.status === "pass" || r.status === "fail");
  }
}

/** Store-side checks after a run: traffic counts in the bots windows, and no 429s or SDK drops. */
export function storeChecks(
  reader: StoreReader,
  appId: string,
  t: Timeline,
  now: number,
  answered: (from: number, to: number) => { humans: number; others: number },
): Problem[] {
  const out: Problem[] = [];
  for (const w of t.countWindows) {
    if (now < w.to + 60_000) continue;
    const stored = reader.requestMix(appId, w.from, w.to);
    const sent = answered(w.from, w.to);
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(5, 0.03 * b);
    if (!close(stored.matters, sent.humans)) {
      out.push({ kind: "count", detail: `${w.scenario}: ${stored.matters} requests counted as traffic that matters, but ${sent.humans} human requests were answered` });
    }
    if (!close(stored.other, sent.others)) {
      out.push({ kind: "count", detail: `${w.scenario}: ${stored.other} bot/probe requests stored, but ${sent.others} were answered` });
    }
  }
  const limited = reader.ingestRejections(appId, t.runStart).filter((r) => r.status === 429).reduce((s, r) => s + r.n, 0);
  if (limited) out.push({ kind: "limits", detail: `ingest refused ${limited} batches with 429` });
  const dropped = Math.max(0, ...reader.metricSeries(appId, "sdk_dropped_events", t.runStart, now + 1).map((m) => m.value));
  if (dropped) out.push({ kind: "limits", detail: `the SDK dropped ${dropped} events` });
  return out;
}

/**
 * The GitHub fixture's patch text and token must never reach the database
 * or its WAL (DECISIONS #137): checked on the raw bytes after every live run.
 */
export function codeLinkChecks(dbPath: string): Problem[] {
  const out: Problem[] = [];
  for (const path of [dbPath, `${dbPath}-wal`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(PATCH_MARKER)) out.push({ kind: "privacy", detail: `GitHub patch text found in ${path}` });
    if (bytes.includes(SIM_GITHUB_TOKEN)) out.push({ kind: "privacy", detail: `the GitHub token found in ${path}` });
  }
  return out;
}

export function mins(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}
