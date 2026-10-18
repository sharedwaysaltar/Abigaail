// Watchdog (agent 3): silence is a finding (SPEC lesson 2). Learns each app's
// heartbeat rhythm and separates a dead process from a revoked or rate-limited
// key, then watches the agents and Abigaail itself. "No human traffic while
// heartbeats continue" belongs to Health, not here.
//
// After Abigaail itself restarts, apps may still be backing off (up to the
// SDK's longest breaker cooldown), so for a grace period silence is reported
// as "reconnecting" (grey) rather than critical: Abigaail's own downtime must
// never turn every app red.

import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { App } from "@abigaail/store";
import { errorClass } from "./evaluate.js";
import { humanDuration, median } from "@abigaail/insights";
import { SCHEDULE, WATCHDOG as W } from "./thresholds.js";
import type { Agent, AgentContext, AgentFinding } from "./types.js";

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;

/** The app's usual heartbeat gap over the last 24 h, or the default. */
export function heartbeatGap(ctx: AgentContext, app: App): { gapMs: number; learned: boolean } {
  const beats = ctx.store
    .lifecycle(app.id, ctx.now - DAY_MS, ctx.now + 1)
    .filter((e) => e.kind === "heartbeat")
    .map((e) => e.ts);
  if (beats.length < W.minHeartbeats) return { gapMs: W.defaultHeartbeatMs, learned: false };
  const gaps = beats.slice(1).map((t, i) => t - beats[i]!);
  return { gapMs: median(gaps) ?? W.defaultHeartbeatMs, learned: true };
}

function forApp(ctx: AgentContext, app: App): AgentFinding[] {
  const out: AgentFinding[] = [];
  const rejections = new Map(
    ctx.store.ingestRejections(app.id, ctx.now - W.rejectionWindowMs).map((r) => [r.status, r.n]),
  );
  const window = humanDuration(W.rejectionWindowMs);

  const revoked = rejections.get(403) ?? 0;
  if (revoked > 0) {
    out.push({
      signal: "key_revoked",
      subject: "",
      severity: "warning",
      summary: `${app.name} is disabled but still sending: ${revoked} batches refused (403) in the last ${window}.`,
      cause: "The app's ingest key was revoked, but the app still runs with it.",
      action: "Remove the old key from the app's environment, or create a new app key and deploy it.",
      evidence: { refused_403: revoked, window_ms: W.rejectionWindowMs },
    });
  }
  const limited = rejections.get(429) ?? 0;
  if (limited > 0) {
    out.push({
      signal: "rate_limited",
      subject: "",
      severity: "warning",
      summary: `${app.name} is being rate-limited: ${limited} batches refused (429) in the last ${window}, so events are being lost.`,
      cause: "The app sends more batches than its ingest rate limit allows.",
      action: "Check for a loop or traffic spike in the app; raise the per-app rate limit if the volume is real.",
      evidence: { refused_429: limited, window_ms: W.rejectionWindowMs },
    });
  }

  // A disabled app is expected to be quiet.
  if (app.disabled_at !== null) return out;

  if (app.last_event_at === null) {
    out.push({
      signal: "no_data_yet",
      subject: "",
      severity: "unknown",
      summary: `${app.name} has never sent an event.`,
      action: "Set ABIGAAIL_ENDPOINT, ABIGAAIL_INGEST_KEY and ABIGAAIL_RELEASE in the app and start it.",
      evidence: { created_at: app.created_at },
      fact: true,
    });
    return out;
  }

  const { gapMs, learned } = heartbeatGap(ctx, app);
  const silentAfter = Math.max(W.silentFactor * gapMs, W.silentMinMs);
  // last_event_at is the server's receive time, so it is compared with now,
  // not with the lagged window end.
  const quietFor = ctx.now - app.last_event_at;
  if (quietFor <= silentAfter) return out;

  const evidence = {
    last_event_at: app.last_event_at,
    quiet_ms: quietFor,
    usual_heartbeat_ms: gapMs,
    heartbeat_learned: learned,
    silent_after_ms: silentAfter,
  };
  const last = ctx.store.lastLifecycle(app.id);
  if (last?.kind === "shutdown") {
    out.push({
      signal: "stopped",
      subject: "",
      severity: "warning",
      summary: `${app.name} stopped cleanly ${humanDuration(ctx.now - last.ts)} ago and has sent nothing since.`,
      cause: "The process shut down normally (a deploy, a stop, or a scale-down).",
      action: "If this was not planned, start the app again.",
      evidence: { ...evidence, shutdown_at: last.ts },
      fact: true,
    });
  } else if (ctx.now - ctx.config.runnerStartedAt < W.sdkMaxBackoffMs + silentAfter) {
    const graceEnds = ctx.config.runnerStartedAt + W.sdkMaxBackoffMs + silentAfter;
    out.push({
      signal: "reconnecting",
      subject: "",
      severity: "unknown",
      summary: `Waiting for ${app.name} to reconnect after Abigaail restarted; nothing received for ${humanDuration(quietFor)}.`,
      cause: "While Abigaail was down the app's SDK backed off, and it can wait up to 5 min before trying again.",
      action: `Nothing yet. If ${app.name} has not reconnected by ${new Date(graceEnds).toISOString()}, it is reported as silent.`,
      evidence: { ...evidence, runner_started_at: ctx.config.runnerStartedAt, grace_ends_at: graceEnds },
      fact: true,
    });
  } else {
    out.push({
      signal: "silent",
      subject: "",
      severity: "critical",
      summary: `${app.name} has been silent for ${humanDuration(quietFor)}; it usually sends a heartbeat every ${humanDuration(gapMs)}.`,
      cause: "No shutdown was reported, so the process likely crashed, hung, or lost its network path to Abigaail.",
      action: "Check that the process is running and can reach the ingest endpoint.",
      evidence,
    });
  }
  return out;
}

function agentHealth(ctx: AgentContext): AgentFinding[] {
  const out: AgentFinding[] = [];
  for (const s of ctx.config.schedules) {
    const runs = ctx.store.recentRuns(s.name, Math.max(W.failingRuns, W.slowRuns));
    const lastOk = ctx.store.lastOkRun(s.name);
    // A run before Abigaail restarted says nothing about this process.
    const since = Math.max(lastOk ?? 0, ctx.config.runnerStartedAt);
    const staleFor = ctx.now - since;
    if (staleFor > W.stalledFactor * s.everyMs) {
      out.push({
        signal: "agent_stalled",
        subject: s.name,
        severity: "critical",
        summary: lastOk === undefined || lastOk < ctx.config.runnerStartedAt
          ? `Agent ${s.name} has not completed a run since Abigaail started ${humanDuration(staleFor)} ago.`
          : `Agent ${s.name} has not completed a run for ${humanDuration(staleFor)}; it runs every ${humanDuration(s.everyMs)}.`,
        cause: "The agent keeps failing, timing out or being skipped, so its view of the apps is out of date.",
        action: "Check the server log and the agent's recent runs.",
        evidence: { last_ok_at: lastOk ?? null, every_ms: s.everyMs, recent_outcomes: runs.slice(0, 5).map((r) => r.outcome) },
      });
      continue;
    }
    const latest = runs.slice(0, W.failingRuns);
    if (latest.length === W.failingRuns && latest.every((r) => r.outcome === "error" || r.outcome === "timeout")) {
      out.push({
        signal: "agent_failing",
        subject: s.name,
        severity: "critical",
        summary: `Agent ${s.name} failed its last ${W.failingRuns} runs (${latest.map((r) => r.outcome).join(", ")}).`,
        action: "Check the server log for the error class and the agent's recent runs.",
        evidence: { outcomes: latest.map((r) => r.outcome), error_classes: latest.map((r) => r.error_class) },
      });
      continue;
    }
    if (s.timeoutMs) {
      const durations = runs.filter((r) => r.outcome === "ok").slice(0, W.slowRuns).map((r) => r.duration_ms);
      const typical = median(durations);
      if (durations.length >= W.failingRuns && typical !== undefined && typical > W.slowShare * s.timeoutMs) {
        out.push({
          signal: "agent_slowing",
          subject: s.name,
          severity: "warning",
          summary: `Agent ${s.name} takes ${humanDuration(typical)} per run, over ${Math.round(W.slowShare * 100)}% of its ${humanDuration(s.timeoutMs)} timeout.`,
          action: "Look for growing data volume; the hourly rollup should keep agent queries small.",
          evidence: { median_ms: typical, timeout_ms: s.timeoutMs, runs: durations.length },
        });
      }
    }
  }
  return out;
}

/**
 * Abigaail's own downtime, from the gap in its run history before this start.
 * Reported (as one deduplicated info finding) during the restart grace period.
 */
function downtime(ctx: AgentContext): AgentFinding[] {
  const from = ctx.config.lastRunBeforeStart;
  const to = ctx.config.runnerStartedAt;
  if (from === null || to - from < W.downMinMs) return [];
  if (ctx.now - to >= W.sdkMaxBackoffMs + W.silentMinMs) return [];
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return [{
    signal: "abigaail_down",
    subject: String(from),
    severity: "info",
    summary: `Abigaail was down from ${iso(from)} to ${iso(to)} (${humanDuration(to - from)}).`,
    cause: "Apps kept their events queued and retried; anything beyond their queue size, or sent during a long breaker cooldown, is missing.",
    action: "Expect a gap in charts for this period. If it was not a planned restart, check the server log and the host.",
    evidence: { down_from: from, down_to: to, down_ms: to - from },
    fact: true,
  }];
}

function database(ctx: AgentContext): AgentFinding[] {
  const bytes = ctx.store.dbBytes();
  const samples = ctx.store.dbSizeSamples(ctx.now - 2 * DAY_MS);
  const first = samples[0];
  const lastSample = samples[samples.length - 1];
  if (!first || !lastSample || lastSample.ts - first.ts < W.growthMinSpanMs) return [];
  const perDay = ((lastSample.bytes - first.bytes) / (lastSample.ts - first.ts)) * DAY_MS;
  const fs = statfsSync(dirname(ctx.config.dbPath));
  const free = fs.bavail * fs.bsize;
  const evidence = { db_bytes: bytes, growth_bytes_per_day: Math.round(perDay), free_bytes: free };
  if (perDay <= 0) return [];
  const daysLeft = free / perDay;
  if (daysLeft >= W.diskWarnDays) return [];
  return [{
    signal: "disk_filling",
    subject: "",
    severity: daysLeft < W.diskCriticalDays ? "critical" : "warning",
    summary: `Abigaail's disk fills in about ${daysLeft.toFixed(1)} days: the database grows ${(perDay / GIB).toFixed(2)} GiB a day and ${(free / GIB).toFixed(1)} GiB is free.`,
    action: "Free disk space or add storage; retention and rollups (Phase 4) will cap growth.",
    evidence: { ...evidence, days_left: Math.round(daysLeft * 10) / 10 },
  }];
}

function salt(ctx: AgentContext): AgentFinding[] {
  if (!ctx.config.saltPath) return [];
  const midnight = Math.floor(ctx.now / DAY_MS) * DAY_MS;
  // Rotation happens at midnight; give it time before calling it failed.
  if (ctx.now - midnight < W.saltGraceMs) return [];
  let mtime: number | undefined;
  try {
    // Only the file's metadata is read, never the salt itself.
    mtime = statSync(ctx.config.saltPath).mtimeMs;
  } catch {
    mtime = undefined;
  }
  if (mtime !== undefined && mtime >= midnight) return [];
  return [{
    signal: "salt_rotation_failed",
    subject: "",
    severity: "critical",
    summary: mtime === undefined
      ? "The visitor-hash salt file is missing."
      : `The visitor-hash salt was last rotated ${humanDuration(ctx.now - mtime)} ago, before today's UTC midnight.`,
    cause: "Rotation failed, so new events get no visitor hash and yesterday's salt may still exist.",
    action: "Check the server log and that the salt file is writable by the server (see DECISIONS #24).",
    evidence: { last_rotated_at: mtime ?? null, utc_midnight: midnight },
  }];
}

function unknownKeys(ctx: AgentContext): AgentFinding[] {
  const n = ctx.store.ingestRejections("", ctx.now - W.rejectionWindowMs).find((r) => r.status === 401)?.n ?? 0;
  if (n < W.unknownKeyMin) return [];
  return [{
    signal: "unknown_keys",
    subject: "",
    severity: "info",
    summary: `${n} ingest requests with a missing or unknown key in the last ${humanDuration(W.rejectionWindowMs)}.`,
    cause: "An app with a mistyped key, or someone guessing keys.",
    action: "Check recently deployed apps' ABIGAAIL_INGEST_KEY; if none changed, this is key guessing and is already rate-limited.",
    evidence: { refused_401: n, window_ms: W.rejectionWindowMs },
  }];
}

/**
 * Each system check runs on its own, so a check that throws (say, statfs on an
 * odd filesystem) is reported and never hides the agent-stall checks.
 */
function guarded(ctx: AgentContext, name: string, check: (ctx: AgentContext) => AgentFinding[]): AgentFinding[] {
  try {
    return check(ctx);
  } catch (err) {
    return [{
      signal: "check_failed",
      subject: name,
      severity: "warning",
      summary: `The Watchdog's ${name} check failed (${errorClass(err)}), so that part of Abigaail is unwatched.`,
      action: "Check the server log and file permissions.",
      evidence: { check: name, error_class: errorClass(err) },
    }];
  }
}

export const watchdog: Agent = {
  name: "watchdog",
  ...SCHEDULE.watchdog,
  forApp,
  forSystem: (ctx) => [
    ...guarded(ctx, "agents", agentHealth),
    ...guarded(ctx, "downtime", downtime),
    ...guarded(ctx, "disk", database),
    ...guarded(ctx, "salt", salt),
    ...guarded(ctx, "ingest keys", unknownKeys),
  ],
};
