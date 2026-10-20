// Replays a run plan against a store with a simulated clock: the traffic model
// and the demo model stand in for the demo app and its SDK, and the real
// Health and Watchdog agents run every minute as the runner would. The tests
// use it to pin each scenario's findings and timings without waiting an hour.

import { evaluate, findingInputs, health, watchdog, type Agent } from "@abigaail/server";
import { HOUR_MS, type Store } from "@abigaail/store";
import { lifecycleItem, requestItems, type Item } from "./events.js";
import { NORMAL_FAULTS, outcome, type Faults } from "./model.js";
import { rng } from "./random.js";
import type { Action, Scenario } from "./scenarios.js";
import { FIRST_RELEASE, insertValidated } from "./seed.js";
import { generate, MIN, NORMAL_MODE, SEC, type AppKind, type Kind, type Mode } from "./traffic.js";
import { Tracker, storeChecks, timeline, type Problem } from "./verify.js";

const AGENTS: readonly Agent[] = [health, watchdog];
const FLUSH_MS = 5 * SEC;

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

  let up = true;
  let release = FIRST_RELEASE;
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
  const boot = (now: number) => {
    buffer.push(lifecycleItem(r, now, "boot", "LON1"));
    lastBeat = now;
  };
  const apply = (a: Action, now: number) => {
    if ("faults" in a) faults = { ...faults, ...a.faults };
    else if ("humans" in a) mode = { ...mode, humans: a.humans };
    else if ("bots" in a) mode = { ...mode, bots: a.bots };
    else if ("extra" in a) mode = { ...mode, extra: a.extra };
    else if ("kill" in a) {
      up = false;
      buffer = []; // queued events die with the process
    } else if ("stop" in a) {
      buffer.push(lifecycleItem(r, now, "shutdown"));
      flush(now);
      up = false;
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
    if (up) {
      for (const req of generate(r, o.app, now, now + SEC, mode)) {
        const items = requestItems(r, req, outcome(r, o.app, req.path, faults));
        buffer.push(...items);
        answered.push({ at: items.at(-1)!.derived.ts, kind: req.kind });
      }
      if (now - lastBeat >= MIN) {
        buffer.push(lifecycleItem(r, now, "heartbeat"));
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
