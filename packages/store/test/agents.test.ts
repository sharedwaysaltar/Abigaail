import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOUR_MS,
  openReadOnly,
  openStore,
  percentile,
  type FindingInput,
  type RunInput,
  type Store,
} from "@abigaail/store";
import type { AbigaailEvent } from "@abigaail/schema";
import type { Derived } from "@abigaail/store";

const T0 = Date.UTC(2026, 9, 19, 10, 0, 0);
let dir: string;
let store: Store;
let clock = T0;
let appA: string;
let appB: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-agents-"));
  clock = T0;
  store = openStore(join(dir, "test.db"), { now: () => clock });
  appA = store.createApp("app-a", "test").app.id;
  appB = store.createApp("app-b", "test").app.id;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function insert(appId: string, items: { event: AbigaailEvent; derived: Derived }[]): void {
  store.insertBatch(appId, { receivedAt: clock, release: "r1", environment: "staging", events: items });
}

// ---- findings lifecycle -----------------------------------------------------

let runAt = T0;
function run(agent: string, outcome: RunInput["outcome"] = "ok", apps_failed = 0): RunInput {
  runAt += 60_000;
  return { agent, started_at: runAt - 1_000, finished_at: runAt, outcome, apps_ok: 2 - apps_failed, apps_failed };
}

function finding(appId: string | null, signal = "5xx", severity: FindingInput["severity"] = "critical"): FindingInput {
  return {
    app_id: appId,
    agent: "health",
    fingerprint: `health:${signal}:/checkout`,
    signal,
    severity,
    summary: "5xx on /checkout",
    action: "look",
    evidence: { failures: 7 },
  };
}

describe("recordRun", () => {
  it("deduplicates by fingerprint and counts hits", () => {
    store.recordRun(run("health"), [finding(appA), finding(appA)], [appA]);
    store.recordRun(run("health"), [finding(appA)], [appA]);
    const open = store.openFindings(appA);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ hits: 2, misses: 0, state: "open", evidence: { failures: 7 } });
    expect(store.recentRuns("health")).toHaveLength(2);
  });

  it("resolves after 3 evaluated runs without the finding", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    store.recordRun(run("health"), [], [appA]);
    store.recordRun(run("health"), [], [appA]);
    expect(store.openFindings(appA)[0]).toMatchObject({ misses: 2 });
    store.recordRun(run("health"), [], [appA]);
    expect(store.openFindings(appA)).toHaveLength(0);
    expect(store.findingHistory(appA)[0]).toMatchObject({ state: "resolved", resolved_at: runAt });
  });

  it("a finding seen again resets misses", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    store.recordRun(run("health"), [], [appA]);
    store.recordRun(run("health"), [], [appA]);
    store.recordRun(run("health"), [finding(appA)], [appA]);
    expect(store.openFindings(appA)[0]).toMatchObject({ misses: 0, hits: 2 });
  });

  it("reopens a finding resolved within the cooldown instead of duplicating it", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    for (let i = 0; i < 3; i++) store.recordRun(run("health"), [], [appA]);
    store.recordRun(run("health"), [finding(appA)], [appA]);
    const history = store.findingHistory(appA);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ state: "open", hits: 1, resolved_at: null });
  });

  it("opens a new finding once the cooldown has passed", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    for (let i = 0; i < 3; i++) store.recordRun(run("health"), [], [appA]);
    runAt += 31 * 60_000;
    store.recordRun(run("health"), [finding(appA)], [appA]);
    expect(store.findingHistory(appA)).toHaveLength(2);
    expect(store.openFindings(appA)).toHaveLength(1);
  });

  it("keeps apps apart, and Abigaail's own findings apart from both", () => {
    store.recordRun(run("watchdog"), [finding(appA), finding(null)], [appA, appB, null]);
    expect(store.openFindings(appA)).toHaveLength(1);
    expect(store.openFindings(appB)).toHaveLength(0);
    expect(store.systemFindings()).toHaveLength(1);
    expect(store.systemFindings()[0]!.app_id).toBeNull();
  });

  // Safety: an agent that cannot see an app must never "recover" it.
  it("misses advance only for apps the agent evaluated successfully", () => {
    store.recordRun(run("health"), [finding(appA), finding(appB)], [appA, appB]);
    // App A fails inside three ok runs; app B is evaluated and quiet.
    for (let i = 0; i < 3; i++) store.recordRun(run("health", "ok", 1), [], [appB]);
    expect(store.openFindings(appA)).toMatchObject([{ severity: "critical", misses: 0 }]);
    expect(store.openFindings(appB)).toHaveLength(0);
  });

  it("error, timeout and skipped runs never advance misses", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    for (const outcome of ["error", "timeout", "skipped", "error"] as const) {
      // Even if a caller passes scopes, a failed run evaluates nothing.
      store.recordRun(run("health", outcome), [], [appA]);
    }
    expect(store.openFindings(appA)).toMatchObject([{ severity: "critical", misses: 0, hits: 1 }]);
    expect(store.recentRuns("health").map((r) => r.outcome)).toEqual(["error", "skipped", "timeout", "error", "ok"]);
  });

  it("a fact resolves on the first evaluated run without it; a signal needs 3", () => {
    store.recordRun(run("health"), [{ ...finding(appA, "stopped", "warning"), fact: true }, finding(appA)], [appA]);
    store.recordRun(run("health"), [], [appA]);
    expect(store.openFindings(appA).map((f) => f.signal)).toEqual(["5xx"]);
    expect(store.findingHistory(appA).find((f) => f.signal === "stopped")).toMatchObject({ state: "resolved", resolves: "fact", misses: 1 });
  });

  it("a fact stays open while its app cannot be evaluated", () => {
    store.recordRun(run("health"), [{ ...finding(appA, "stopped", "warning"), fact: true }], [appA]);
    store.recordRun(run("health", "ok", 1), [], [appB]);
    store.recordRun(run("health", "timeout"), [], [appA]);
    expect(store.openFindings(appA)).toMatchObject([{ signal: "stopped", misses: 0 }]);
  });

  it("does not touch other agents' findings", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    for (let i = 0; i < 3; i++) store.recordRun(run("usage"), [], [appA]);
    expect(store.openFindings(appA)).toHaveLength(1);
  });
});

describe("appStatus", () => {
  const status = () => store.appStatus(appA, { now: runAt }).status;

  it("is grey until the health agent has run", () => {
    expect(status()).toBe("grey");
    store.recordRun(run("health"), [], [appA]);
    expect(status()).toBe("green");
  });

  it("is red only once a critical finding has held for 2 runs, amber before", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    expect(status()).toBe("amber");
    store.recordRun(run("health"), [finding(appA)], [appA]);
    expect(status()).toBe("red");
  });

  it("stays red until the finding resolves after 3 good runs", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    store.recordRun(run("health"), [finding(appA)], [appA]);
    store.recordRun(run("health"), [], [appA]);
    store.recordRun(run("health"), [], [appA]);
    expect(status()).toBe("red");
    store.recordRun(run("health"), [], [appA]);
    expect(status()).toBe("green");
  });

  it("grey for an unknown finding, info never changes status, stale health is grey", () => {
    store.recordRun(run("usage"), [{ ...finding(appA, "peak", "info"), agent: "usage", fingerprint: "usage:peak:" }], [appA]);
    store.recordRun(run("health"), [], [appA]);
    expect(status()).toBe("green");
    store.recordRun(run("health"), [finding(appA, "no_data", "unknown")], [appA]);
    expect(status()).toBe("grey");
    expect(store.appStatus(appA, { now: runAt + 10 * 60_000 }).status).toBe("grey");
  });
});

// ---- rollup -----------------------------------------------------------------

interface Fx {
  ts: number;
  route: string;
  status: number;
  duration_ms: number;
  sample_rate?: number;
  bot_class: string;
  visitor: string;
  flags?: ("scanner_path" | "injection_like" | "auth_failure")[];
  referrer?: string;
}

function seedHour(hour: number): Fx[] {
  const fx: Fx[] = [];
  let k = 0;
  for (let i = 0; i < 40; i++) {
    fx.push({
      ts: hour + (k++ * 61_000) % HOUR_MS,
      route: i % 3 ? "/a" : "/b/[id]",
      status: i % 9 === 0 ? 503 : i % 7 === 0 ? 401 : 200,
      duration_ms: 10 + ((i * 37) % 200),
      ...(i % 5 === 0 ? { sample_rate: 0.5 } : {}),
      bot_class: i % 11 === 0 ? "crawler" : i % 13 === 0 ? "unknown" : "human",
      visitor: `v${i % 6}`,
      ...(i % 17 === 0 ? { flags: ["scanner_path" as const] } : i % 8 === 0 ? { flags: ["auth_failure" as const] } : {}),
      ...(i % 4 === 0 ? { referrer: i % 8 ? "news.example" : "search.example" } : {}),
    });
  }
  insert(
    appA,
    fx.map((f) => ({
      event: {
        type: "request",
        event_id: id(),
        client_ts: f.ts,
        method: "GET",
        route: f.route,
        status: f.status,
        duration_ms: f.duration_ms,
        ...(f.sample_rate ? { sample_rate: f.sample_rate } : {}),
        ...(f.flags ? { flags: f.flags } : {}),
        ...(f.referrer ? { referrer_domain: f.referrer } : {}),
      },
      derived: { ts: f.ts, visitor_hash: f.visitor, bot_class: f.bot_class, browser: null },
    })),
  );
  // Outbound calls, errors and metrics in the same hour.
  insert(appA, [
    ...[5, 9, 120, 3000].map((d, i) => ({
      event: { type: "outbound" as const, event_id: id(), client_ts: 1, host: "api.stripe.com", method: "POST" as const,
        duration_ms: d, outcome: i === 3 ? ("timeout" as const) : ("ok" as const), ...(i === 2 ? { status: 502 } : {}) },
      derived: { ts: hour + i * 1000 },
    })),
    ...[1, 2].map((i) => ({
      event: { type: "error" as const, event_id: id(), client_ts: 1, error_type: "TypeError", handled: false, route: "/a" },
      derived: { ts: hour + i * 1000 },
    })),
    ...[100, 300, 200].map((v, i) => ({
      event: { type: "metric" as const, event_id: id(), client_ts: 1, name: "memory_rss_mb" as const, value: v },
      derived: { ts: hour + i * 1000 },
    })),
  ]);
  return fx;
}

/** The same statistics, computed directly from the fixture in plain JS. */
function expectedRoutes(fx: Fx[]) {
  const matters = fx.filter(
    (f) => !["crawler", "ai_crawler", "automation"].includes(f.bot_class) &&
      !f.flags?.some((g) => g === "scanner_path" || g === "injection_like"),
  );
  const routes = [...new Set(matters.map((f) => f.route))].sort();
  return routes.map((route) => {
    const rows = matters.filter((f) => f.route === route);
    const d = rows.map((r) => r.duration_ms).sort((a, b) => a - b);
    const nearest = (p: number) => d[Math.ceil((p / 100) * d.length) - 1];
    return {
      key: route,
      n: rows.length,
      weighted_n: rows.reduce((s, r) => s + 1 / (r.sample_rate ?? 1), 0),
      status_5xx: rows.filter((r) => r.status >= 500).length,
      status_4xx: rows.filter((r) => r.status >= 400 && r.status < 500).length,
      status_401_403: rows.filter((r) => r.status === 401 || r.status === 403).length,
      failures: 0,
      p50: nearest(50),
      p95: nearest(95),
      p99: nearest(99),
      uniques: new Set(rows.map((r) => r.visitor)).size,
    };
  });
}

describe("hourly rollup", () => {
  const H = T0 - 2 * HOUR_MS;

  it("route stats match a direct calculation over the raw events", () => {
    const fx = seedHour(H);
    store.rollupHour(appA, H);
    const got = store.hourly(appA, "route", [H]).map(({ hour, ...r }) => r);
    expect(got).toEqual(expectedRoutes(fx));
    // Bots and scanner probes are excluded; "unknown" counts.
    expect(got.reduce((s, r) => s + r.n, 0)).toBeLessThan(fx.length);
  });

  it("host, referrer, error and metric stats match the raw events", () => {
    const fx = seedHour(H);
    store.rollupHour(appA, H);
    expect(store.hourly(appA, "host", [H])).toMatchObject([
      // The 502 answer and the timeout both count as failed calls.
      { key: "api.stripe.com", n: 4, failures: 2, status_5xx: 1, p50: 9, p95: 3000 },
    ]);
    const refs = fx.filter((f) => f.referrer && f.bot_class !== "crawler" && !f.flags?.includes("scanner_path"));
    const refRows = store.hourly(appA, "referrer", [H]);
    expect(refRows.map((r) => r.key)).toEqual([...new Set(refs.map((f) => f.referrer))].sort());
    for (const r of refRows) {
      const rows = refs.filter((f) => f.referrer === r.key);
      expect(r.n).toBe(rows.length);
      expect(r.uniques).toBe(new Set(rows.map((f) => f.visitor)).size);
    }
    expect(store.hourly(appA, "error", [H])).toMatchObject([{ key: "TypeError /a", n: 2 }]);
    expect(store.hourly(appA, "metric", [H])).toMatchObject([{ key: "memory_rss_mb", n: 3, p50: 200, p99: 300 }]);
  });

  it("a window read over the same hour equals the rollup (one source of truth)", () => {
    seedHour(H);
    store.rollupHour(appA, H);
    const rolled = store.hourly(appA, "route", [H]).map(({ hour, ...r }) => r);
    expect(store.statsFor(appA, "route", H, H + HOUR_MS)).toEqual(rolled);
  });

  it("is idempotent and picks up late events when re-rolled", () => {
    seedHour(H);
    store.rollupHour(appA, H);
    const before = store.hourly(appA, "route", [H]);
    store.rollupHour(appA, H);
    expect(store.hourly(appA, "route", [H])).toEqual(before);
    insert(appA, [{
      event: { type: "request", event_id: id(), client_ts: 1, method: "GET", route: "/late", status: 200, duration_ms: 1 },
      derived: { ts: H + 10, bot_class: "human" },
    }]);
    store.rollupHour(appA, H);
    expect(store.hourly(appA, "route", [H], "/late")).toHaveLength(1);
  });

  it("records the hour's event count and the day's unique humans; scoped by app", () => {
    seedHour(H);
    store.rollupHour(appA, H);
    store.rollupHour(appB, H);
    expect(store.rolledHours(appA, [H, H + HOUR_MS])).toEqual(new Map([[H, 49]]));
    expect(store.rolledHours(appB, [H])).toEqual(new Map([[H, 0]]));
    expect(store.hourly(appB, "route", [H])).toEqual([]);
    const day = new Date(H).toISOString().slice(0, 10);
    expect(store.dailyUniques(appA, [day]).get(day)).toBe(6);
  });

  it("lists missing hours", () => {
    store.rollupHour(appA, H);
    expect(store.missingHours(appA, H - HOUR_MS, H + 2 * HOUR_MS)).toEqual([H - HOUR_MS, H + HOUR_MS]);
  });

  it("refuses an hour that is not on the hour", () => {
    expect(() => store.rollupHour(appA, H + 1)).toThrow();
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([7], 99)).toBe(7);
  });
});

describe("ingest rejections, size samples, parent_id, read-only access", () => {
  it("adds rejection counts per app, minute and status; '' holds unknown keys", () => {
    store.addIngestRejections([
      { app_id: appA, minute: T0, status: 403, n: 2 },
      { app_id: appA, minute: T0, status: 403, n: 3 },
      { app_id: appA, minute: T0 + 60_000, status: 429, n: 1 },
      { app_id: "", minute: T0, status: 401, n: 9 },
    ]);
    expect(store.ingestRejections(appA, T0)).toEqual([{ status: 403, n: 5 }, { status: 429, n: 1 }]);
    expect(store.ingestRejections(appA, T0 + 60_000)).toEqual([{ status: 429, n: 1 }]);
    expect(store.ingestRejections("", T0)).toEqual([{ status: 401, n: 9 }]);
    expect(store.ingestRejections(appB, T0)).toEqual([]);
  });

  it("samples the database size", () => {
    store.sampleDbSize();
    const [s] = store.dbSizeSamples(T0);
    expect(s).toMatchObject({ ts: T0 });
    expect(s!.bytes).toBeGreaterThan(0);
  });

  it("stores parent_id for outbound and error events", () => {
    const parent = id();
    insert(appA, [
      { event: { type: "outbound", event_id: id(), client_ts: 1, host: "h.example", method: "GET", duration_ms: 1, outcome: "ok", parent_id: parent }, derived: { ts: T0 } },
      { event: { type: "error", event_id: id(), client_ts: 1, error_type: "E", handled: true, parent_id: parent }, derived: { ts: T0 } },
    ]);
    expect(store.recentEvents(appA).map((e) => e.parent_id)).toEqual([parent, parent]);
  });

  it("a read-only connection reads but refuses every write", () => {
    store.recordRun(run("health"), [finding(appA)], [appA]);
    const ro = openReadOnly(join(dir, "test.db"));
    try {
      expect(ro.openFindings(appA)).toHaveLength(1);
      // The connection itself refuses writes, whatever code holds it.
      const db = (ro as unknown as { db: { exec(sql: string): void } }).db;
      expect(() => db.exec("DELETE FROM findings")).toThrow(/readonly/i);
      expect(() => db.exec("UPDATE apps SET disabled_at = 1")).toThrow(/readonly/i);
    } finally {
      ro.close();
    }
  });
});
