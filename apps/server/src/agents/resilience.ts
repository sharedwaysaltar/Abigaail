// Resilience (agent 4): does the app stay up and stay healthy over its life
// (docs/AGENTS.md)? Restart loops with their cause, memory leaks as a rising
// post-GC floor, the route that blocks the event loop, and the cost of a cold
// start. The rules live in @abigaail/insights (resilience.ts) because Health
// folds into them and the dashboard shows the same numbers.

import type { App } from "@abigaail/store";
import {
  baselineSlots,
  blockingRoutes,
  humanDuration,
  leakVerdicts,
  restartVerdict,
  rowsByKey,
  startupVerdict,
  typicalP95,
  type Crash,
  type LeakVerdict,
} from "@abigaail/insights";
import { RESILIENCE as R, SCHEDULE } from "./thresholds.js";
import type { Agent, AgentContext, AgentFinding } from "./types.js";

const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const mb = (x: number) => `${Math.round(x)} MB`;
const hhmm = (ts: number) => `${new Date(ts).toISOString().slice(11, 16)} UTC`;

// ---- restarts --------------------------------------------------------------------

const RESTART_ACTION: Record<Crash["cause"]["kind"], string> = {
  error: "Fix the uncaught error at the frame shown: it ends the process. Until then the process manager keeps restarting it.",
  exit: "Something called process.exit with this code; check the app's logs around the restart.",
  fatal_error: "Fix the uncaught error shown: it ends the process.",
  oom: "Find what keeps memory growing (Runtime tab: memory since start); a higher heap limit only delays it.",
  oom_trend: "Find what keeps memory growing (Runtime tab: memory since start); a higher heap or container limit only delays it.",
  container_oom: "Reduce memory use or raise the container's memory limit; the kernel kills the process at the limit.",
  unknown: "Check the host's logs (systemd, Docker, pm2) for the signal; an unexplained SIGKILL is often the OOM killer.",
};

/** The cause that ended most of the recent restarts, in words. */
function commonCause(crashes: Crash[]): Crash {
  const counts = new Map<string, number>();
  for (const c of crashes) counts.set(c.text, (counts.get(c.text) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  return crashes.findLast((c) => c.text === top)!;
}

function restarts(ctx: AgentContext, app: App): AgentFinding[] {
  const v = restartVerdict(ctx.store, app.id, ctx.now);
  if (!v) return [];
  const recent = v.crashes.filter((c) => c.ts >= ctx.now - R.restartWindowMs);
  const top = commonCause(recent);
  const times = v.recent === 1 ? "once" : `${v.recent} times`;
  const longer = v.crashes.length > v.recent ? ` (${v.crashes.length} in the last ${humanDuration(R.loopLongMs)})` : "";
  const each = recent.every((c) => c.text === top.text) && recent.length > 1 ? "Each time: " : recent.length > 1 ? "Most often: " : "";
  return [{
    signal: "restart",
    subject: "",
    severity: v.severity,
    summary: `${app.name} restarted ${times} in the last 15 min without a clean shutdown${longer}${v.loop ? ": a restart loop" : ""}. ${each}${top.text}.`,
    cause: top.replaced
      ? `${top.text[0]!.toUpperCase()}${top.text.slice(1)}; a new instance took its place.`
      : `${top.text[0]!.toUpperCase()}${top.text.slice(1)}.`,
    action: RESTART_ACTION[top.cause.kind],
    evidence: {
      window_ms: R.restartWindowMs,
      loop: v.loop,
      restarts_15_min: v.recent,
      restarts_2_h: v.crashes.length,
      crashes: v.crashes.map((c) => ({ ts: c.ts, release: c.release, instance: c.instance, replaced: c.replaced, cause: c.cause })),
    },
  }];
}

// ---- leaks -------------------------------------------------------------------------

const LEAK_WHAT: Record<LeakVerdict["kind"], string> = {
  heap: "heap floor after garbage collection",
  external: "external memory (Buffers, ArrayBuffers)",
  rss: "memory (RSS) floor",
};
const LEAK_CAUSE: Record<LeakVerdict["kind"], string> = {
  heap: "JavaScript objects stay reachable: a cache or Map that only grows, listeners or timers added per request and never removed, or closures holding large data.",
  external: "Buffers or ArrayBuffers stay referenced: buffered uploads or responses kept in memory, or a pool that never shrinks.",
  rss: "The JavaScript heap is flat, so native memory grows: a native addon, an allocator holding freed memory, or many threads.",
};

function leaks(ctx: AgentContext, app: App): AgentFinding[] {
  return leakVerdicts(ctx.store, app.id, ctx.windowEnd).map((v) => {
    const limit = v.limit_mb !== null && v.hours_to_limit !== null
      ? `; at this rate it reaches its ${mb(v.limit_mb)} limit in about ${humanDuration(v.hours_to_limit * 3_600_000)}`
      : "";
    return {
      signal: "leak",
      subject: v.kind,
      severity: v.severity,
      summary:
        `${app.name}'s ${LEAK_WHAT[v.kind]} rose from ${mb(v.first_mb)} to ${mb(v.last_mb)} over ${humanDuration(v.span_ms)} ` +
        `since it started at ${hhmm(v.boot_ts)} (+${v.mb_per_hour} MB/h)${limit}.`,
      cause: LEAK_CAUSE[v.kind],
      action: "Look for what grows per request or per hour (caches, maps, listeners, buffers); a restart only resets it. The Runtime tab shows the floor since the start.",
      evidence: { ...v },
    };
  });
}

// ---- event-loop blocks -------------------------------------------------------------

function blocks(ctx: AgentContext, app: App): AgentFinding[] {
  return blockingRoutes(ctx.store, app.id, ctx.windowEnd).map((b) => ({
    signal: "loop_blocked",
    subject: b.route,
    severity: b.severity,
    summary:
      `${b.route} blocked the event loop ${b.blocks} times in 15 min (max ${ms(b.max_ms)}, ${ms(b.blocked_ms)} in all): ` +
      `${Math.round(b.share * 100)}% of the blocks in ${app.name}. Every other request waits while it runs.`,
    cause: `Synchronous work in ${b.route}'s handler (CPU-heavy code, sync I/O, a large JSON.parse or stringify, a slow regex).`,
    action: "Move the heavy work to a worker thread, stream or paginate it, or make it asynchronous.",
    evidence: { window_ms: R.blockWindowMs, ...b },
  }));
}

// ---- cold start ----------------------------------------------------------------------

function coldStart(ctx: AgentContext, app: App): AgentFinding[] {
  const end = ctx.windowEnd;
  const v = startupVerdict(ctx.store, app.id, end);
  const parts: string[] = [];
  const evidence: Record<string, unknown> = {};
  let release: string | undefined;
  if (v?.slow) {
    release = v.release;
    parts.push(v.normal_ms !== null ? `took ${ms(v.startup_ms)} to start, ${(v.startup_ms / v.normal_ms).toFixed(1)}× its usual ${ms(v.normal_ms)}` : `took ${ms(v.startup_ms)} to start`);
    Object.assign(evidence, { startup: v });
  }
  // The first requests after a start, against the app's usual p95 for this hour.
  const boot = ctx.store.lastBoot(app.id);
  if (boot && end - boot.ts >= R.coldWindowMs && end - boot.ts <= R.coldShowMs) {
    const first = ctx.store.statsFor(app.id, "app", boot.ts, boot.ts + R.coldWindowMs)[0];
    const slots = baselineSlots(ctx.store, app.id, boot.ts);
    const normal = typicalP95(rowsByKey(ctx.store, app.id, "app", slots).get("*"));
    if (first && first.n >= R.coldMinRequests && first.p95 !== null && normal && first.p95 >= R.coldRatio * normal.median) {
      release ??= boot.release;
      parts.push(`answered its first ${first.n} requests with p95 ${ms(first.p95)}, ${(first.p95 / normal.median).toFixed(1)}× its usual ${ms(normal.median)}`);
      Object.assign(evidence, { first_requests: { window_ms: R.coldWindowMs, requests: first.n, p95: first.p95, baseline_p95: normal.median, baseline: slots.source } });
    }
  }
  if (!release) return [];
  return [{
    signal: "cold_start",
    subject: release,
    severity: "warning",
    summary: `${app.name} (release ${release}) ${parts.join(" and ")} after starting${v ? ` at ${hhmm(v.ts)}` : ""}.`,
    cause: "Work at startup or on first use: loading large modules, warming caches, compiling templates, or connecting to dependencies one by one.",
    action: "Defer what is not needed for the first request, warm caches in the background, and open connections in parallel.",
    evidence,
    fact: true,
  }];
}

// ---- the agent ---------------------------------------------------------------------------

function forApp(ctx: AgentContext, app: App): AgentFinding[] {
  if (app.disabled_at !== null) return [];
  return [...restarts(ctx, app), ...leaks(ctx, app), ...blocks(ctx, app), ...coldStart(ctx, app)];
}

export const resilience: Agent = {
  name: "resilience",
  ...SCHEDULE.resilience,
  forApp,
};
