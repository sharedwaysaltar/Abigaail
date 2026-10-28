// Fixtures for agent tests: a temp-file store with a fixed clock, events
// written as ingest would store them, and past hours rolled up as baselines.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, findingInputs, type Agent, type AgentContext, type AgentFinding } from "@abigaail/server";
import { HOUR_MS, openStore, type Store } from "@abigaail/store";
import type { AbigaailEvent, LifecycleEvent, MetricName, RequestFlag } from "@abigaail/schema";
import type { Derived } from "@abigaail/store";

export const MIN = 60_000;
export const WEEK = 7 * 24 * HOUR_MS;
/** Wednesday 2026-10-21 14:30 UTC: the current hour is 14:00. */
export const NOW = Date.UTC(2026, 9, 21, 14, 30, 0);

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

export interface Req {
  route?: string;
  status?: number;
  duration?: number;
  bot?: string;
  flags?: RequestFlag[];
  sample_rate?: number;
  visitor?: string;
  referrer?: string;
  id?: string;
}

export class Fx {
  readonly dir = mkdtempSync(join(tmpdir(), "abigaail-agentfx-"));
  readonly dbPath = join(this.dir, "test.db");
  now = NOW;
  readonly store: Store = openStore(this.dbPath, { now: () => this.now });
  readonly appId: string;

  constructor(name = "app") {
    this.appId = this.store.createApp(name, "test").app.id;
  }

  close(): void {
    this.store.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private put(items: { event: AbigaailEvent; derived: Derived }[], release = "r1"): void {
    for (let i = 0; i < items.length; i += 400) {
      const slice = items.slice(i, i + 400);
      const at = Math.max(...slice.map((s) => s.derived.ts));
      this.store.insertBatch(this.appId, { receivedAt: at, release, environment: "test", events: slice });
    }
  }

  /** `count` requests spread evenly over [from, to). */
  requests(from: number, to: number, count: number, r: Req | ((i: number) => Req) = {}, release?: string): string[] {
    const ids: string[] = [];
    const items = Array.from({ length: count }, (_, i) => {
      const q = typeof r === "function" ? r(i) : r;
      const event_id = q.id ?? id();
      ids.push(event_id);
      const ts = from + Math.floor(((to - from) * i) / count);
      return {
        event: {
          type: "request" as const,
          event_id,
          client_ts: ts,
          method: "GET" as const,
          route: q.route ?? "/",
          status: q.status ?? 200,
          duration_ms: q.duration ?? 50,
          ...(q.sample_rate ? { sample_rate: q.sample_rate } : {}),
          ...(q.flags ? { flags: q.flags } : {}),
          ...(q.referrer ? { referrer_domain: q.referrer } : {}),
        },
        derived: { ts, bot_class: q.bot ?? "human", visitor_hash: q.visitor ?? `v${i % 50}`, browser: null },
      };
    });
    this.put(items, release);
    return ids;
  }

  outbound(ts: number, host: string, o: { outcome?: "ok" | "error" | "timeout"; status?: number; duration?: number; parent?: string } = {}): void {
    this.put([{
      event: {
        type: "outbound",
        event_id: id(),
        client_ts: ts,
        host,
        method: "POST",
        duration_ms: o.duration ?? 100,
        outcome: o.outcome ?? "ok",
        ...(o.status ? { status: o.status } : {}),
        ...(o.parent ? { parent_id: o.parent } : {}),
      },
      derived: { ts },
    }]);
  }

  error(ts: number, type: string, route?: string, frame?: { file: string; line: number; fn?: string }, release?: string): void {
    this.put([{
      event: { type: "error", event_id: id(), client_ts: ts, error_type: type, handled: false, ...(route ? { route } : {}), ...(frame ? { frames: [frame] } : {}) },
      derived: { ts },
    }], release);
  }

  metric(ts: number, name: MetricName, value: number): void {
    this.put([{ event: { type: "metric", event_id: id(), client_ts: ts, name, value }, derived: { ts } }]);
  }

  /** A lifecycle event; returns its event_id (a boot's id is what its ready event names). */
  lifecycle(ts: number, kind: LifecycleEvent["kind"], release = "r1", extra: Partial<LifecycleEvent> = {}): string {
    const event_id = id();
    this.put([{ event: { type: "lifecycle", event_id, client_ts: ts, kind, ...extra }, derived: { ts } }], release);
    return event_id;
  }

  /** A process start as the SDK with runtime signals reports it: boot, then ready naming it. */
  start(ts: number, o: { release?: string; instance?: string; startup_ms?: number; heap_limit_mb?: number; memory_limit_mb?: number; prev_exit?: LifecycleEvent["prev_exit"] } = {}): string {
    const { release = "r1", instance = "0123456789ab", ...ready } = o;
    const boot = this.lifecycle(ts, "boot", release);
    this.lifecycle(ts + 1_000, "ready", release, { boot_id: boot, instance, heap_limit_mb: 4096, ...ready });
    return boot;
  }

  /** A profile whose stacks are given as frame lists (outermost first) with weights. */
  profile(ts: number, kind: "cpu" | "block" | "heap", stacks: { frames: { file: string; line: number; fn?: string }[]; weight: number }[], o: { route?: string; window_ms?: number } = {}): void {
    const frames: { file: string; line: number; fn?: string }[] = [];
    const key = (f: { file: string; line: number; fn?: string }) => `${f.file}:${f.line}:${f.fn ?? ""}`;
    const idx = (f: { file: string; line: number; fn?: string }) => {
      const i = frames.findIndex((x) => key(x) === key(f));
      return i >= 0 ? i : frames.push(f) - 1;
    };
    const s = stacks.map((st) => ({ frames: st.frames.map(idx), weight: st.weight }));
    this.put([{
      event: { type: "profile", event_id: id(), client_ts: ts, kind, window_ms: o.window_ms ?? 10_000, samples: stacks.reduce((a, b) => a + b.weight, 0), frames, stacks: s, ...(o.route ? { route: o.route } : {}) },
      derived: { ts },
    }]);
  }

  block(ts: number, route: string | undefined, count: number, total_ms: number, max_ms: number): void {
    this.put([{ event: { type: "block", event_id: id(), client_ts: ts, ...(route ? { route } : {}), count, total_ms, max_ms }, derived: { ts } }]);
  }

  /** Heartbeats every minute over [from, to). */
  heartbeats(from: number, to: number): void {
    for (let t = from; t < to; t += MIN) this.lifecycle(t, "heartbeat");
  }

  /** The same hour-of-week as `at`, `weeks` weeks back, filled by `fill` and rolled up. */
  baselineWeeks(at: number, weeks: number, fill: (hourStart: number) => void): void {
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    for (let k = 1; k <= weeks; k++) {
      const h = hour - k * WEEK;
      fill(h);
      this.store.rollupHour(this.appId, h);
    }
  }

  ctx(agentNow = this.now): AgentContext {
    return {
      store: this.store,
      apps: this.store.listApps(),
      now: agentNow,
      windowEnd: agentNow - 45_000,
      config: { dbPath: this.dbPath, schedules: [], runnerStartedAt: agentNow - 60 * MIN, lastRunBeforeStart: null },
    };
  }

  /** Findings the agent returns for this app now. */
  run(agent: Agent): AgentFinding[] {
    const result = evaluate(agent, this.ctx());
    if (result.failed.length) throw new Error(`agent failed: ${JSON.stringify(result.failed)}`);
    return result.findings.filter((f) => f.app_id === this.appId);
  }

  /** Run and record exactly as the runner does; returns the app's status afterwards. */
  runAndRecord(agent: Agent): string {
    const result = evaluate(agent, this.ctx());
    this.store.recordRun(
      { agent: agent.name, started_at: this.now - 100, finished_at: this.now, outcome: "ok", apps_ok: 1, apps_failed: 0 },
      findingInputs(agent.name, result),
      result.evaluated,
    );
    return this.store.appStatus(this.appId, { now: this.now }).status;
  }
}

export const signals = (fs: AgentFinding[]) => fs.map((f) => `${f.signal}:${f.subject}:${f.severity}`).sort();
