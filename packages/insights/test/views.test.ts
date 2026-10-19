import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS } from "@abigaail/server";
import {
  agentsView,
  appSummary,
  EVAL_LAG_MS,
  findingsFor,
  fourNumbers,
  headline,
  responseSeries,
  routesThatChanged,
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

  it("SCHEDULE covers every registered agent with the same timings", () => {
    for (const a of AGENTS) expect(SCHEDULE[a.name as keyof typeof SCHEDULE]).toEqual({ everyMs: a.everyMs, timeoutMs: a.timeoutMs });
  });
});
