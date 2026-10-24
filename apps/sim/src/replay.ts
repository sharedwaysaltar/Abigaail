// Replays a run plan against a store with a simulated clock: the traffic model
// and the demo model stand in for the demo app and its SDK (with runtime
// signals: ready, instance, heap, blocks), and the real Health, Watchdog and
// Resilience agents run every minute as the runner would. The tests use it to
// pin each scenario's findings and timings without waiting hours.

import { evaluate, findingInputs, health, resilience, watchdog, type Agent } from "@abigaail/server";
import { HOUR_MS, type Store } from "@abigaail/store";
import { blockItem, lifecycleItem, metricItem, profileItem, requestItems, type Item } from "./events.js";
import { BLOCK_DOCS_MS, DEMO_FRAMES, NORMAL_FAULTS, outcome, type Faults } from "./model.js";
import { rng, uuid } from "./random.js";
import type { Action, Scenario } from "./scenarios.js";
import { FIRST_RELEASE, insertValidated } from "./seed.js";
import { generate, MIN, NORMAL_MODE, SEC, type AppKind, type Kind, type Mode } from "./traffic.js";
import { Tracker, storeChecks, timeline, type Problem } from "./verify.js";

const AGENTS: readonly Agent[] = [health, watchdog, resilience];
const FLUSH_MS = 5 * SEC;

/** The demo's SDK as the model sends it (runtime_v1, DECISIONS #110). */
export const RUNTIME_MODEL = {
  instance: "51de0000d0e5",
  /** ready follows the boot once the first batch is answered. */
  readyAfterMs: SEC,
  startupMs: 250,
  heapLimitMb: 4144,
  /** The demo's heap after start; it grows only by the leak fault. */
  baseHeapMb: 19,
  rssOverHeapMb: 45,
  metricsMs: 30 * SEC,
  /** A supervisor restarts a process that died on its own after this long. */
  restartAfterMs: 2 * SEC,
  /** Profiling (profiler.ts): a 20 s CPU window every 5 min at 10 ms, sent every 5 min; heap profiles at 2, 4, 6, 8, 10 min, then every 5. */
  profiledShare: 20 / 300,
  sampleMs: 10,
  profileSendMs: 5 * MIN,
  heapEarlyMs: 2 * MIN,
  heapEarlyForMs: 10 * MIN,
  heapEveryMs: 5 * MIN,
} as const;

export interface ReplayOptions {
  store: Store;
  appId: string;
  app: AppKind;
  plan: readonly { scenario: Scenario; at: number }[];
  /** When the stack is up (the runner starts). */
  start: number;
  seed?: number;
  /** Stop after this long even if something is still waiting. */
  maxMs?: number;
  /** Outbound calls and errors carry the request's parent_id (default true; Node 22's SDK default is false). */
  linkOutbound?: boolean;
}

export interface ReplayResult {
  tracker: Tracker;
  problems: Problem[];
  endedAt: number;
}

export function replay(o: ReplayOptions): ReplayResult {
  const r = rng(o.seed ?? 7);
  const t = timeline(o.start, o.plan);
  const tracker = new Tracker(t);
  const steps = o.plan
    .flatMap(({ scenario, at }) => scenario.steps.map((s) => ({ at: o.start + at + s.at, action: s.action })))
    .sort((a, b) => a.at - b.at);
  const faultsOver = Math.max(o.start, ...o.plan.map((p) => o.start + p.at + p.scenario.faultMs)) + 2 * MIN;
  const lastDeadline = Math.max(faultsOver, ...t.items.map((i) => i.faultEndAt + i.exp.resolveWithinMs));
  const end = o.start + (o.maxMs ?? lastDeadline - o.start + 2 * MIN);

  const M = RUNTIME_MODEL;
  let up = true;
  let supervise = false;
  let restartAt: number | undefined;
  let release = FIRST_RELEASE;
  // The running process: its heap, its pending ready, its blocks this interval.
  let heapMb: number = M.baseHeapMb;
  let ready: { at: number; bootId: string } | undefined;
  let lastMetrics = o.start;
  let docsBlocks = 0;
  let bootAt = o.start;
  let blockSamples = 0;
  let lastProfileSend = o.start;
  let lastHeap = o.start;
  let faults: Faults = { ...NORMAL_FAULTS };
  let mode: Mode = { ...NORMAL_MODE };
  let buffer: Item[] = [];
  let lastBeat = o.start;
  let lastFlush = o.start;
  let rolledThrough = Math.floor(o.start / HOUR_MS) * HOUR_MS;
  const answered: { at: number; kind: Kind }[] = [];

  const flush = (now: number) => {
    for (let i = 0; i < buffer.length; i += 500) insertValidated(o.store, o.appId, release, buffer.slice(i, i + 500), now);
    buffer = [];
    lastFlush = now;
  };
  const instance = { instance: M.instance };
  const boot = (now: number) => {
    const bootId = uuid(r);
    buffer.push(lifecycleItem(r, now, "boot", "LON1", { event_id: bootId }));
    ready = { at: now + M.readyAfterMs, bootId };
    lastBeat = now;
    lastMetrics = now;
    heapMb = M.baseHeapMb;
    docsBlocks = 0;
    bootAt = lastProfileSend = lastHeap = now;
    blockSamples = 0;
  };
  /** The demo's profiles: CPU samples inside blocks (renderDocs) and the live heap by site (rememberSearch). */
  const profiles = (now: number) => {
    if (now - lastProfileSend >= M.profileSendMs) {
      if (blockSamples >= 1) {
        buffer.push(profileItem(r, now, "block", M.profileSendMs * M.profiledShare, [{ frames: [DEMO_FRAMES.handler, DEMO_FRAMES.renderDocs], weight: blockSamples }]));
      }
      blockSamples = 0;
      lastProfileSend = now;
    }
    const heapEvery = now - bootAt < M.heapEarlyForMs ? M.heapEarlyMs : M.heapEveryMs;
    if (now - lastHeap >= heapEvery) {
      buffer.push(
        profileItem(r, now, "heap", now - bootAt, [
          { frames: [DEMO_FRAMES.handler], weight: M.baseHeapMb * 1048576 },
          { frames: [DEMO_FRAMES.handler, DEMO_FRAMES.rememberSearch], weight: (heapMb - M.baseHeapMb) * 1048576 },
        ]),
      );
      lastHeap = now;
    }
  };
  /** Killed (by us, or by the OOM killer): no shutdown, queued events are lost. */
  const die = (now: number, unexpected: boolean) => {
    up = false;
    buffer = [];
    ready = undefined;
    if (unexpected && supervise) restartAt = now + M.restartAfterMs;
  };
  const metrics = (now: number) => {
    const saw = r() * 8;
    buffer.push(
      metricItem(r, now, "heap_floor_mb", heapMb),
      metricItem(r, now, "memory_heap_used_mb", heapMb + saw),
      metricItem(r, now, "memory_rss_mb", heapMb + saw + M.rssOverHeapMb),
      metricItem(r, now, "memory_external_mb", 1.5),
      metricItem(r, now, "event_loop_blocks", docsBlocks),
    );
    if (docsBlocks) buffer.push(blockItem(r, now, "/docs", docsBlocks, docsBlocks * BLOCK_DOCS_MS, BLOCK_DOCS_MS));
    blockSamples += docsBlocks * (BLOCK_DOCS_MS / M.sampleMs) * M.profiledShare;
    docsBlocks = 0;
    lastMetrics = now;
  };
  const apply = (a: Action, now: number) => {
    if ("faults" in a) faults = { ...faults, ...a.faults };
    else if ("humans" in a) mode = { ...mode, humans: a.humans };
    else if ("bots" in a) mode = { ...mode, bots: a.bots };
    else if ("extra" in a) mode = { ...mode, extra: a.extra };
    else if ("supervise" in a) supervise = a.supervise;
    else if ("kill" in a) die(now, false);
    else if ("stop" in a) {
      buffer.push(lifecycleItem(r, now, "shutdown", undefined, instance));
      flush(now);
      up = false;
      ready = undefined;
    } else if ("start" in a) {
      if (a.start.release) release = a.start.release;
      up = true;
      boot(now);
    }
  };

  boot(o.start);
  let i = 0;
  for (let now = o.start; now < end; now += SEC) {
    while (i < steps.length && steps[i]!.at <= now) apply(steps[i++]!.action, now);
    if (!up && restartAt !== undefined && now >= restartAt) {
      restartAt = undefined;
      up = true;
      boot(now);
    }
    if (up) {
      if (ready && now >= ready.at) {
        buffer.push(lifecycleItem(r, now, "ready", undefined, { ...instance, boot_id: ready.bootId, startup_ms: M.startupMs, heap_limit_mb: M.heapLimitMb }));
        ready = undefined;
      }
      for (const req of generate(r, o.app, now, now + SEC, mode)) {
        const out = outcome(r, o.app, req.path, faults);
        const items = requestItems(r, req, out);
        if (o.linkOutbound === false) for (const i of items) if ("parent_id" in i.event) delete i.event.parent_id;
        buffer.push(...items);
        answered.push({ at: items.at(-1)!.derived.ts, kind: req.kind });
        if (out.route === "/docs" && faults.blockDocs) docsBlocks++;
        if (out.route === "/search" && faults.leakPerRequest) {
          heapMb += faults.leakPerRequest / 1024;
          if (faults.oomKillMb && heapMb > faults.oomKillMb) {
            die(now, true);
            break;
          }
        }
      }
    }
    if (up && faults.leakPerSecond) {
      heapMb += faults.leakPerSecond / 1024;
      if (faults.oomKillMb && heapMb > faults.oomKillMb) die(now, true);
    }
    if (up) {
      if (now - lastMetrics >= M.metricsMs) metrics(now);
      profiles(now);
      if (now - lastBeat >= MIN) {
        buffer.push(lifecycleItem(r, now, "heartbeat", undefined, instance));
        lastBeat = now;
      }
      if (now - lastFlush >= FLUSH_MS) flush(now);
    }
    // The runner ticks one second past each minute.
    if (now % MIN === SEC) {
      const closed = Math.floor(now / HOUR_MS) * HOUR_MS;
      if (closed > rolledThrough) {
        for (let h = rolledThrough; h < closed; h += HOUR_MS) o.store.rollupHour(o.appId, h);
        rolledThrough = closed;
      }
      for (const agent of AGENTS) {
        const result = evaluate(agent, {
          store: o.store,
          apps: o.store.listApps(),
          now,
          windowEnd: now - 45_000,
          config: { dbPath: ":memory:", schedules: [], runnerStartedAt: o.start, lastRunBeforeStart: null },
        });
        o.store.recordRun(
          { agent: agent.name, started_at: now, finished_at: now + 100, outcome: "ok", apps_ok: result.evaluated.length, apps_failed: result.failed.length },
          findingInputs(agent.name, result),
          result.evaluated,
        );
      }
      tracker.observe(o.store.findingsSince(o.appId, o.start, 500));
      if (now >= faultsOver && tracker.settled(now)) {
        return { tracker, problems: [...tracker.problems(), ...checks(now)], endedAt: now };
      }
    }
  }
  return { tracker, problems: [...tracker.problems(), ...checks(end)], endedAt: end };

  function checks(now: number): Problem[] {
    return storeChecks(o.store, o.appId, t, now, (from, to) => {
      const inWindow = answered.filter((a) => a.at >= from && a.at < to);
      return { humans: inWindow.filter((a) => a.kind === "human").length, others: inWindow.filter((a) => a.kind !== "human").length };
    });
  }
}
