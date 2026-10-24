import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS, Retention, loadRetention } from "@abigaail/server";
import {
  agentsView,
  appRetention,
  appSummary,
  EVAL_LAG_MS,
  findingsFor,
  fourNumbers,
  headline,
  responseSeries,
  retentionView,
  routesThatChanged,
  profileView,
  runtimeView,
  SCHEDULE,
  servers,
  systemFindingsView,
  usageNumbers,
  type AppSummary,
} from "@abigaail/insights";
import { HOUR_MS, openStore, type App, type AppStatus, type Store } from "@abigaail/store";
import type { AbigaailEvent } from "@abigaail/schema";

const WEEK = 7 * 24 * HOUR_MS;
// 10:30 UTC on a Monday; "now" windows end 45 s earlier.
const NOW = Date.UTC(2026, 9, 19, 10, 30, 0);
let dir: string;
let store: Store;
let app: App;
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-views-"));
  store = openStore(join(dir, "test.db"), { now: () => NOW });
  app = store.createApp("shop", "test").app;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function put(events: { event: AbigaailEvent; ts: number; bot?: string }[]): void {
  store.insertBatch(app.id, {
    receivedAt: NOW,
    release: "r1",
    environment: "production",
    events: events.map((e) => ({ event: e.event, derived: { ts: e.ts, bot_class: e.bot ?? "human", visitor_hash: "v", browser: null } })),
  });
}

/** `count` requests spread over [from, from + span), with the given durations and statuses. */
function requests(from: number, span: number, count: number, opts: { route?: string; ms?: number; status?: number; bot?: string } = {}): void {
  put(
    Array.from({ length: count }, (_, i) => ({
      ts: from + Math.floor((i * span) / count),
      bot: opts.bot,
      event: { type: "request", event_id: id(), client_ts: 1, method: "GET", route: opts.route ?? "/", status: opts.status ?? 200, duration_ms: (opts.ms ?? 100) + (i % 5) },
    })),
  );
}

const healthRanOk = () =>
  store.recordRun({ agent: "health", started_at: NOW - 30_000, finished_at: NOW - 29_000, outcome: "ok", apps_ok: 1, apps_failed: 0 }, [], [app.id]);
const fresh = () => store.listApps().find((a) => a.id === app.id)!;
const end = NOW - EVAL_LAG_MS;

describe("appSummary", () => {
  it("an app with no data is grey 'Too little data', with no p95, never Healthy", () => {
    const s = appSummary(store, fresh(), NOW);
    expect(s.status).toBe("grey");
    expect(s.line).toBe("Too little data");
    expect(s.p95).toBeNull();
    expect(s.liveness).toEqual({ kind: "never" });
  });

  it("stays grey while Health has not run, even with traffic", () => {
    requests(end - 10 * 60_000, 10 * 60_000, 50);
    expect(appSummary(store, fresh(), NOW).status).toBe("grey");
    healthRanOk();
    const s = appSummary(store, fresh(), NOW);
    expect(s.status).toBe("green");
    expect(s.line).toBe("Healthy");
    expect(s.p95).not.toBeNull();
    expect(s.rpm).toBeCloseTo(50 / 15);
  });

  it("bots do not count towards requests or p95", () => {
    requests(end - 10 * 60_000, 10 * 60_000, 50, { bot: "crawler" });
    const s = appSummary(store, fresh(), NOW);
    expect(s.requests).toBe(0);
    expect(s.p95).toBeNull();
  });

  it("reports process uptime from the latest boot", () => {
    put([{ ts: NOW - 3 * HOUR_MS, event: { type: "lifecycle", event_id: id(), client_ts: 1, kind: "boot" } }]);
    expect(appSummary(store, fresh(), NOW).liveness).toEqual({ kind: "running", since: NOW - 3 * HOUR_MS });
  });

  it("the line is the most severe open finding, info never counts", () => {
    healthRanOk();
    const base = { app_id: app.id, agent: "health", action: "do", evidence: {} };
    store.recordRun({ agent: "health", started_at: NOW - 2000, finished_at: NOW - 1000, outcome: "ok", apps_ok: 1, apps_failed: 0 }, [
      { ...base, fingerprint: "health:deploy:", signal: "deploy", severity: "info", summary: "deployed" },
      { ...base, fingerprint: "health:latency:/", signal: "latency", severity: "warning", summary: "slow /" },
    ], [app.id]);
    const s = appSummary(store, fresh(), NOW);
    expect(s.status).toBe("amber");
    expect(s.line).toBe("slow /");
  });
});

describe("fourNumbers", () => {
  it("below the minimum evidence, rates and p95 are null with 'too little data'", () => {
    requests(end - 5 * 60_000, 5 * 60_000, 5);
    const [rpm, errors, p95, lag] = fourNumbers(store, app.id, NOW);
    expect(rpm!.value).toBeCloseTo(5 / 15);
    expect(errors).toMatchObject({ value: null, reason: "too little data" });
    expect(p95).toMatchObject({ value: null, reason: "too little data" });
    expect(lag).toMatchObject({ value: null, reason: "too little data" });
  });

  it("with traffic but no history, values show and usual says 'no baseline yet'", () => {
    requests(end - 10 * 60_000, 10 * 60_000, 40, { status: 200 });
    requests(end - 10 * 60_000, 10 * 60_000, 10, { status: 503 });
    const [rpm, errors, p95] = fourNumbers(store, app.id, NOW);
    expect(rpm).toMatchObject({ usual: null, reason: "no baseline yet", source: "none" });
    expect(errors!.value).toBeCloseTo(20);
    expect(errors!.reason).toBe("no baseline yet");
    expect(p95!.value).not.toBeNull();
  });

  it("compares against the same hour of the week", () => {
    const hour = Math.floor(end / HOUR_MS) * HOUR_MS;
    for (const k of [1, 2, 3]) {
      requests(hour - k * WEEK, HOUR_MS, 600, { ms: 200 });
      store.rollupHour(app.id, hour - k * WEEK);
    }
    requests(end - 15 * 60_000, 15 * 60_000, 150, { ms: 200 });
    const [rpm, errors, p95] = fourNumbers(store, app.id, NOW);
    expect(rpm).toMatchObject({ source: "hour-of-week" });
    expect(rpm!.usual).toBeCloseTo(10);
    expect(rpm!.value).toBeCloseTo(10);
    expect(errors!.usual).toBe(0);
    expect(p95!.usual).toBe(204);
  });
});

describe("responseSeries", () => {
  it("hours with no events are gaps, never zero; hours from before the app kind are 'building'", () => {
    const closed = Math.floor(end / HOUR_MS) * HOUR_MS;
    const h1 = closed - HOUR_MS;
    const h2 = closed - 2 * HOUR_MS;
    requests(h1, HOUR_MS, 30, { ms: 300 });
    requests(h2, HOUR_MS, 30, { ms: 300 });
    for (const h of [h1, h2, closed - 3 * HOUR_MS]) store.rollupHour(app.id, h);
    const db = new DatabaseSync(join(dir, "test.db"));
    db.prepare("DELETE FROM hourly_route_stats WHERE kind = 'app' AND hour = ?").run(h2);
    db.close();
    const series = responseSeries(store, app.id, NOW);
    expect(series).toHaveLength(24);
    const at = (h: number) => series.find((p) => p.hour === h)!;
    expect(at(h1)).toMatchObject({ state: "ok", p95: 304 });
    expect(at(h2)).toMatchObject({ state: "building", p95: null });
    expect(at(closed - 3 * HOUR_MS)).toMatchObject({ state: "no-data", p95: null });
    expect(at(closed - 10 * HOUR_MS)).toMatchObject({ state: "no-data", p95: null });
    expect(series.every((p) => p.p95 !== 0)).toBe(true);
  });

  it("each hour has a band around its own normal, wider than nothing even when history is steady", () => {
    const closed = Math.floor(end / HOUR_MS) * HOUR_MS;
    const h = closed - HOUR_MS;
    for (const k of [1, 2]) {
      requests(h - k * WEEK, HOUR_MS, 30, { ms: 300 });
      store.rollupHour(app.id, h - k * WEEK);
    }
    const band = responseSeries(store, app.id, NOW).find((p) => p.hour === h)!.band!;
    expect(band.mid).toBe(304);
    expect(band.lo).toBeLessThan(band.mid);
    expect(band.hi).toBeGreaterThan(band.mid);
  });
});

describe("routesThatChanged", () => {
  it("says 'no baseline yet' without history and flags a slower route with one", () => {
    const hour = Math.floor(end / HOUR_MS) * HOUR_MS - HOUR_MS;
    requests(hour, HOUR_MS, 40, { route: "/checkout", ms: 900 });
    requests(hour, HOUR_MS, 40, { route: "/home", ms: 100 });
    store.rollupHour(app.id, hour);
    expect(routesThatChanged(store, app.id, NOW).reason).toBe("no baseline yet");
    for (const k of [1, 2]) {
      requests(hour - k * WEEK, HOUR_MS, 40, { route: "/checkout", ms: 300 });
      requests(hour - k * WEEK, HOUR_MS, 40, { route: "/home", ms: 100 });
      store.rollupHour(app.id, hour - k * WEEK);
    }
    const { changes, reason } = routesThatChanged(store, app.id, NOW);
    expect(reason).toBeUndefined();
    expect(changes).toEqual([{ route: "/checkout", kind: "slower", now: 904, usual: 304 }]);
  });
});

describe("servers and headline", () => {
  const summary = (name: string, status: AppStatus, region: string | null): AppSummary =>
    ({ app: { ...app, id: name, name, region }, status } as AppSummary);
  const table = (r: string) => (r === "LON1" || r === "FRA1" ? { lat: 51, lon: 0, city: r } : undefined);

  it("groups apps by region, worst status per pin, and lists the rest as not on the map", () => {
    const { servers: list, unplaced } = servers(
      [summary("a", "green", "LON1"), summary("b", "red", "LON1"), summary("c", "grey", "FRA1"), summary("d", "green", null), summary("e", "green", "MARS1")],
      table,
    );
    expect(list.map((s) => [s.region, s.status, s.apps.length])).toEqual([["LON1", "red", 2], ["FRA1", "grey", 1]]);
    expect(unplaced.map((u) => u.app.name)).toEqual(["d", "e"]);
  });

  it("a grey pin is never shown as green", () => {
    expect(servers([summary("a", "green", "LON1"), summary("b", "grey", "LON1")], table).servers[0]!.status).toBe("grey");
  });

  it("answers 'is everything OK?' in one sentence", () => {
    expect(headline([])).toEqual({ status: "grey", text: "No apps yet" });
    expect(headline([summary("a", "green", null)]).text).toBe("Everything is fine");
    expect(headline([summary("a", "green", null), summary("b", "grey", null)])).toEqual({ status: "grey", text: "Nothing needs you; 1 app has too little data" });
    expect(headline([summary("a", "amber", null), summary("b", "red", null)])).toEqual({ status: "red", text: "2 apps need you" });
  });
});

describe("findings, usage and agents views stay scoped by app", () => {
  const finding = (appId: string | null, signal: string, severity: "critical" | "warning" | "info" = "warning", agent = "health") => ({
    app_id: appId, agent, fingerprint: `${agent}:${signal}:`, signal, severity, summary: `${signal} for ${appId}`, action: "x", evidence: {},
  });
  const run = (agent: string, findings: ReturnType<typeof finding>[], evaluated: (string | null)[], at = NOW - 30_000, outcome: "ok" | "error" = "ok") =>
    store.recordRun({ agent, started_at: at - 1000, finished_at: at, outcome, apps_ok: 1, apps_failed: 0 }, findings, evaluated);

  it("findingsFor returns one app's findings only, open worst first, resolved newest first", () => {
    const other = store.createApp("other", "test").app;
    run("health", [finding(app.id, "latency"), finding(app.id, "server_errors", "critical"), finding(other.id, "memory", "critical"), finding(null, "disk")], [app.id, other.id, null]);
    expect(findingsFor(store, app.id, { state: "open", now: NOW }).map((f) => f.signal)).toEqual(["server_errors", "latency"]);
    expect(findingsFor(store, other.id, { state: "open", now: NOW }).map((f) => f.signal)).toEqual(["memory"]);
    expect(systemFindingsView(store).map((f) => f.signal)).toEqual(["disk"]);
    // Three quiet runs resolve the app's findings, not the other app's.
    for (let k = 1; k <= 3; k++) run("health", [finding(other.id, "memory", "critical")], [app.id, other.id], NOW - 30_000 + k * 1000);
    expect(findingsFor(store, app.id, { state: "open", now: NOW })).toEqual([]);
    expect(findingsFor(store, app.id, { state: "resolved", now: NOW }).map((f) => f.signal).sort()).toEqual(["latency", "server_errors"]);
    expect(findingsFor(store, other.id, { state: "resolved", now: NOW })).toEqual([]);
  });

  it("usageNumbers reads one app's rollup only, and no data is not zero", () => {
    const other = store.createApp("other", "test").app;
    const hour = Math.floor(end / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;
    expect(usageNumbers(store, app.id, NOW).requests).toBeNull();

    requests(hour, HOUR_MS, 30, { route: "/mine" });
    const saved = app;
    app = other;
    requests(hour, HOUR_MS, 50, { route: "/theirs" });
    app = saved;
    store.rollupHour(app.id, hour);
    store.rollupHour(other.id, hour);
    const u = usageNumbers(store, app.id, NOW);
    expect(u.requests).toBe(30);
    expect(u.hoursWithData).toBe(1);
    expect(u.topRoutes).toEqual([{ route: "/mine", requests: 30 }]);
    expect(usageNumbers(store, other.id, NOW).topRoutes).toEqual([{ route: "/theirs", requests: 50 }]);
    expect(u.uniques.value).toBeNull();
    expect(u.uniques.usual).toBeNull();
  });

  it("agentsView takes each agent's status from the Watchdog's findings, never its own rules", () => {
    run("watchdog", [], [null]);
    run("health", [], [app.id], NOW - 40_000, "error");
    let rows = agentsView(store, [app], NOW);
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["health", "watchdog", "usage", "rollup"]));
    // Health failed its last run, but the Watchdog has not said so: not red.
    expect(rows.find((r) => r.name === "health")!.status).toBe("green");
    expect(rows.find((r) => r.name === "usage")!.status).toBe("grey");
    expect(rows.find((r) => r.name === "health")!.day).toMatchObject({ error: 1, ok: 0 });

    run("watchdog", [{ ...finding(null, "agent_failing", "critical", "watchdog"), fingerprint: "watchdog:agent_failing:health" }], [null], NOW - 20_000);
    rows = agentsView(store, [app], NOW);
    const h = rows.find((r) => r.name === "health")!;
    expect(h.status).toBe("red");
    expect(h.finding?.signal).toBe("agent_failing");
    // Without a fresh Watchdog run nothing is judged: grey, not green.
    expect(agentsView(store, [app], NOW + 10 * 60_000).find((r) => r.name === "watchdog")!.status).toBe("grey");
  });

  it("the alerts row is grey and off with no channel configured, judged like the others with one", () => {
    run("watchdog", [], [null]);
    store.recordRun({ agent: "alerts", started_at: NOW - 30_000, finished_at: NOW - 30_000, outcome: "ok", apps_ok: 0, apps_failed: 0 }, [], []);
    expect(agentsView(store, [app], NOW).find((r) => r.name === "alerts")).toMatchObject({ status: "grey", off: "off (no channel configured)" });
    store.writeAlertChannels([{ channel: "webhook", label: "webhook (ntfy, ntfy.sh)" }]);
    const row = agentsView(store, [app], NOW).find((r) => r.name === "alerts")!;
    expect(row.status).toBe("green");
    expect(row.off).toBeUndefined();
    // Other agents are never "off".
    expect(agentsView(store, [app], NOW).filter((r) => r.off).map((r) => r.name)).toEqual([]);
  });

  it("SCHEDULE covers every registered agent with the same timings", () => {
    for (const a of AGENTS) expect(SCHEDULE[a.name as keyof typeof SCHEDULE]).toEqual({ everyMs: a.everyMs, timeoutMs: a.timeoutMs });
  });
});

describe("retention on the dashboard", () => {
  it("shows what the server recorded, in a fixed order; nothing before the server ran", async () => {
    expect(retentionView(store)).toEqual([]);
    expect(appRetention(store, app.id)).toEqual({ eventsDays: null, rollupsDays: null, oldestEvent: null });
    requests(NOW - HOUR_MS, HOUR_MS, 3);
    const job = new Retention({ store, days: { ...loadRetention({}), events: 14 }, now: () => NOW, log: () => {} });
    await job.runOnce();
    const rows = retentionView(store);
    expect(rows.map((r) => r.name)).toEqual(["events", "rollups", "daily_uniques", "findings", "agent_runs", "ingest_rejections", "db_size_samples", "audit_log", "alerts", "profiles", "sessions"]);
    expect(rows[0]).toMatchObject({ keepDays: 14, lastRunAt: NOW, lastDeleted: 0 });
    expect(rows.at(-1)).toMatchObject({ name: "sessions", keepDays: 0 });
    expect(appRetention(store, app.id)).toEqual({ eventsDays: 14, rollupsDays: 400, oldestEvent: NOW - HOUR_MS });
    // Retention is scheduled like the rollup, so the Agents page and the Watchdog know it.
    expect(SCHEDULE.retention).toEqual({ everyMs: HOUR_MS });
    expect(agentsView(store, [app], NOW).find((a) => a.name === "retention")).toMatchObject({ schedule: { everyMs: HOUR_MS } });
  });
});

describe("runtimeView", () => {
  const MIN = 60_000;
  it("an app without runtime signals says so, with nothing else to show", () => {
    requests(NOW - 10 * MIN, 5 * MIN, 30);
    const v = runtimeView(store, app.id, NOW);
    expect(v).toMatchObject({ signals: false, leaks: [], blockingNow: [], blocks24h: [], crashes: [], startups: [], usualStartupMs: null, findings: [] });
    expect(v.memory.every((p) => p.heapFloor === null && p.rss === null)).toBe(true);
  });

  it("memory is the lowest reading per 15 min; blocks are summed per route; startups and limits come from ready", () => {
    const boot = id();
    put([
      { ts: NOW - 3 * HOUR_MS, event: { type: "lifecycle", event_id: boot, client_ts: 1, kind: "boot" } },
      { ts: NOW - 3 * HOUR_MS + 1000, event: { type: "lifecycle", event_id: id(), client_ts: 1, kind: "ready", boot_id: boot, instance: "0123456789ab", startup_ms: 820, heap_limit_mb: 4096 } },
      ...[90, 80, 85].map((value, i) => ({ ts: NOW - 2 * HOUR_MS + i * MIN, event: { type: "metric" as const, event_id: id(), client_ts: 1, name: "heap_floor_mb" as const, value } })),
      ...[1, 2].map((i) => ({ ts: NOW - HOUR_MS + i * MIN, event: { type: "block" as const, event_id: id(), client_ts: 1, route: "/report", count: 2, total_ms: 600, max_ms: 400 } })),
    ]);
    const v = runtimeView(store, app.id, NOW);
    expect(v.signals).toBe(true);
    expect(v.memory.find((p) => p.heapFloor !== null)?.heapFloor).toBe(80);
    // A short history starts at its first reading, not 24 h back.
    expect(v.memory[0]!.heapFloor).toBe(80);
    expect(v.memory[0]!.t).toBeGreaterThanOrEqual(NOW - 2 * HOUR_MS - 15 * MIN);
    expect(v.memory.length).toBeLessThanOrEqual(10);
    expect(v.blocks24h).toEqual([{ route: "/report", blocks: 4, blocked_ms: 1200, max_ms: 400 }]);
    expect(v.startups).toEqual([{ ts: NOW - 3 * HOUR_MS + 1000, release: "r1", startup_ms: 820 }]);
    expect(v.heapLimitMb).toBe(4096);
    // The boot is before the first reading, so it is outside the chart.
    expect(v.boots).toEqual([]);
  });
});

describe("profileView", () => {
  const A = { file: "src/a.ts", line: 3, fn: "handle" };
  const B = { file: "src/b.ts", line: 9, fn: "render" };
  const GC = { file: "(gc)", line: 0 };
  const profile = (ts: number, kind: "cpu" | "block" | "heap", stacks: { frames: number[]; weight: number }[], o: { route?: string; concurrent?: number; idle?: number } = {}) =>
    put([{
      ts,
      event: {
        type: "profile", event_id: id(), client_ts: 1, kind, window_ms: 10_000, samples: stacks.reduce((a, b) => a + b.weight, 0), frames: [A, B, GC], stacks,
        ...(o.route ? { route: o.route } : {}), ...(o.concurrent !== undefined ? { samples_concurrent: o.concurrent, samples_idle: o.idle ?? 0 } : {}),
      },
    }]);

  it("merges profiles: top functions by self time, a flame tree, routes, and the concurrent/idle share", () => {
    profile(NOW - 30 * 60_000, "cpu", [{ frames: [0, 1], weight: 60 }, { frames: [0], weight: 30 }, { frames: [2], weight: 10 }], { concurrent: 20, idle: 5 });
    profile(NOW - 20 * 60_000, "cpu", [{ frames: [0, 1], weight: 40 }], { concurrent: 0, idle: 0 });
    profile(NOW - 20 * 60_000, "cpu", [{ frames: [0, 1], weight: 70 }], { route: "/report" });
    const v = profileView(store, app.id, NOW, { windowMs: HOUR_MS, route: null });
    expect(v.cpu).toMatchObject({ samples: 140, concurrent: 20, idle: 5, profiles: 2 });
    expect(v.cpu!.top[0]).toMatchObject({ label: "render (src/b.ts:9)", self: 100, total: 100 });
    expect(v.cpu!.top.find((f) => f.label === "handle (src/a.ts:3)")).toMatchObject({ self: 30, total: 130 });
    expect(v.cpu!.flame.children[0]).toMatchObject({ label: "handle (src/a.ts:3)", value: 130, children: [{ label: "render (src/b.ts:9)", value: 100 }] });
    expect(v.routes).toEqual([{ route: "/report", samples: 70 }]);
    const r = profileView(store, app.id, NOW, { windowMs: HOUR_MS, route: "/report" });
    expect(r.cpu).toMatchObject({ samples: 70, profiles: 1 });
  });

  it("the SDK's own frames (from an SDK that did not group them) are one (abigaail) row, never named behind blocks", () => {
    const sdk = (file: string) => ({ file, line: 10, fn: "tick" });
    put([{
      ts: NOW - 10 * 60_000,
      event: {
        type: "profile", event_id: id(), client_ts: 1, kind: "block", window_ms: 10_000, samples: 100,
        frames: [A, sdk("packages/node/dist/runtime.js"), sdk("node_modules/@abigaail/core/dist/client.js")],
        stacks: [{ frames: [0, 1, 2], weight: 70 }, { frames: [0, 1], weight: 30 }],
      },
    }]);
    profile(NOW - 10 * 60_000, "cpu", [{ frames: [0], weight: 10 }]);
    put([{
      ts: NOW - 9 * 60_000,
      event: { type: "profile", event_id: id(), client_ts: 1, kind: "cpu", window_ms: 10_000, samples: 50, frames: [sdk("packages/node/dist/profiler.js"), sdk("node_modules/@abigaail/schema/dist/x.js")], stacks: [{ frames: [0], weight: 30 }, { frames: [1], weight: 20 }] },
    }]);
    const v = profileView(store, app.id, NOW, { windowMs: HOUR_MS, route: null });
    // Blocked inside the SDK's code under handle(): the app's handle() is what is named.
    expect(v.block[0]).toMatchObject({ label: "handle (src/a.ts:3)", selfShare: 1 });
    expect(v.cpu!.top.filter((f) => f.label === "(abigaail)")).toEqual([expect.objectContaining({ self: 50 })]);
    expect(v.cpu!.top.some((f) => f.label.includes("tick"))).toBe(false);
  });

  it("heap sites growing since the start, and the functions behind blocks", () => {
    put([{ ts: NOW - 2 * HOUR_MS, event: { type: "lifecycle", event_id: id(), client_ts: 1, kind: "boot" } }]);
    profile(NOW - 100 * 60_000, "heap", [{ frames: [0, 1], weight: 1 * 1048576 }, { frames: [0], weight: 4 * 1048576 }]);
    profile(NOW - 10 * 60_000, "heap", [{ frames: [0, 1], weight: 41 * 1048576 }, { frames: [0], weight: 4 * 1048576 }]);
    profile(NOW - 10 * 60_000, "block", [{ frames: [0, 1], weight: 30 }]);
    const v = profileView(store, app.id, NOW, { windowMs: HOUR_MS, route: null });
    expect(v.heapGrowing).toEqual([expect.objectContaining({ label: "render (src/b.ts:9)", firstBytes: 1048576, lastBytes: 41 * 1048576 })]);
    expect(v.block[0]).toMatchObject({ label: "render (src/b.ts:9)", selfShare: 1 });
    expect(v.cpu).toBeNull();
  });
});
