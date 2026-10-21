import { mkdtempSync, rmSync, statfsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate, findingInputs, loadRetention, Retention, watchdog, type AgentContext } from "@abigaail/server";
import { openStore, type App, type RunInput, type Store } from "@abigaail/store";

const MIN = 60_000;
const DAY = 86_400_000;
// 10:00 UTC, well clear of midnight unless a test moves it.
let now = Date.UTC(2026, 9, 19, 10, 0, 0);
let dir: string;
let dbPath: string;
let saltPath: string;
let store: Store;

beforeEach(() => {
  now = Date.UTC(2026, 9, 19, 10, 0, 0);
  dir = mkdtempSync(join(tmpdir(), "abigaail-watchdog-"));
  dbPath = join(dir, "test.db");
  saltPath = join(dir, "salt.bin");
  writeFileSync(saltPath, "x");
  utimesSync(saltPath, new Date(now - MIN), new Date(now - MIN));
  store = openStore(dbPath, { now: () => now });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function ctx(overrides: Partial<AgentContext["config"]> = {}): AgentContext {
  return {
    store,
    apps: store.listApps(),
    now,
    windowEnd: now - 45_000,
    config: {
      dbPath,
      saltPath,
      // By default Abigaail has been up for an hour, with no agents to watch.
      schedules: [],
      runnerStartedAt: now - 60 * MIN,
      lastRunBeforeStart: null,
      ...overrides,
    },
  };
}

const run = (c = ctx()) => evaluate(watchdog, c);
const signals = (c = ctx()) => run(c).findings.map((f) => `${f.app_id === null ? "system" : "app"}:${f.signal}:${f.severity}`);

/** An app that sent a lifecycle event at each of the given times (received then). */
function appWith(name: string, beats: { ts: number; kind?: "boot" | "heartbeat" | "shutdown" }[]): App {
  const { app } = store.createApp(name, "test");
  for (const b of beats) {
    store.insertBatch(app.id, {
      receivedAt: b.ts,
      release: "r",
      environment: "test",
      events: [{ event: { type: "lifecycle", event_id: id(), client_ts: 1, kind: b.kind ?? "heartbeat" }, derived: { ts: b.ts } }],
    });
  }
  return store.appByName(name)!;
}

const every = (gapMs: number, until: number, count = 20) =>
  Array.from({ length: count }, (_, i) => ({ ts: until - (count - 1 - i) * gapMs }));

describe("silence", () => {
  it("an app that heartbeats every minute is silent after 3 minutes without events", () => {
    appWith("a", every(MIN, now - 2 * MIN));
    expect(signals()).not.toContain("app:silent:critical");
    appWith("b", every(MIN, now - 4 * MIN));
    const found = run().findings.filter((f) => f.signal === "silent");
    expect(found).toHaveLength(1);
    expect(found[0]!.summary).toMatch(/b has been silent for 4 min; it usually sends a heartbeat every 1 min/);
  });

  it("learns a slower rhythm: 5-minute heartbeats are not silent after 10 minutes, but are after 16", () => {
    appWith("a", every(5 * MIN, now - 10 * MIN));
    expect(signals()).toEqual([]);
    now += 6 * MIN;
    const [f] = run().findings;
    expect(f).toMatchObject({ signal: "silent", severity: "critical", evidence: { usual_heartbeat_ms: 5 * MIN, heartbeat_learned: true } });
  });

  it("a clean shutdown is a warning, not a crash", () => {
    appWith("a", [...every(MIN, now - 10 * MIN), { ts: now - 9 * MIN, kind: "shutdown" }]);
    expect(signals()).toEqual(["app:stopped:warning"]);
  });

  it("an app that never sent anything is unknown (grey), not silent", () => {
    store.createApp("new", "test");
    expect(signals()).toEqual(["app:no_data_yet:unknown"]);
  });

  it("a disabled app is expected to be quiet", () => {
    appWith("a", every(MIN, now - 30 * MIN));
    store.disableApp("a", "test");
    expect(signals()).toEqual([]);
  });
});

describe("ingest refusals", () => {
  it("separates a revoked key (403) and rate limiting (429) from a dead process", () => {
    const a = appWith("a", every(MIN, now - MIN));
    store.disableApp("a", "test");
    const b = appWith("b", every(MIN, now - MIN));
    store.addIngestRejections([
      { app_id: a.id, minute: now - 2 * MIN, status: 403, n: 4 },
      { app_id: b.id, minute: now - MIN, status: 429, n: 7 },
      // Outside the 5-minute window: ignored.
      { app_id: b.id, minute: now - 30 * MIN, status: 403, n: 1 },
    ]);
    const found = run().findings;
    expect(found.find((f) => f.app_id === a.id)).toMatchObject({ signal: "key_revoked", severity: "warning", evidence: { refused_403: 4 } });
    expect(found.find((f) => f.app_id === b.id)).toMatchObject({ signal: "rate_limited", severity: "warning", evidence: { refused_429: 7 } });
    expect(found).toHaveLength(2);
  });

  it("reports a flood of unknown-key requests as info about Abigaail", () => {
    store.addIngestRejections([{ app_id: "", minute: now - MIN, status: 401, n: 80 }]);
    expect(signals()).toEqual(["system:unknown_keys:info"]);
  });
});

const WATCHDOG_SCHEDULE = [{ name: "watchdog", everyMs: MIN, timeoutMs: 20_000 }];

describe("agents", () => {
  const wd = (o: Partial<AgentContext["config"]> = {}) => ctx({ schedules: WATCHDOG_SCHEDULE, ...o });
  let at = 0;
  const record = (agent: string, outcome: RunInput["outcome"], durationMs = 100) => {
    at += MIN;
    store.recordRun({ agent, started_at: at - durationMs, finished_at: at, outcome, apps_ok: 0, apps_failed: 0 }, [], []);
  };

  it("a new install is not stalled", () => {
    expect(signals(wd({ runnerStartedAt: now - MIN }))).toEqual([]);
  });

  it("an agent with no good run for 3 schedules is stalled", () => {
    at = now - 10 * MIN;
    record("watchdog", "ok");
    expect(signals(wd())).toEqual(["system:agent_stalled:critical"]);
  });

  it("3 failed runs in a row is failing; a good run in between is not", () => {
    at = now - 4 * MIN;
    record("watchdog", "ok");
    record("watchdog", "error");
    record("watchdog", "timeout");
    expect(signals(wd())).toEqual([]);
    record("watchdog", "error");
    expect(run(wd()).findings).toMatchObject([{ signal: "agent_failing", subject: "watchdog", severity: "critical" }]);
  });

  it("runs taking over half the timeout are slowing", () => {
    at = now - 5 * MIN;
    for (let i = 0; i < 4; i++) record("watchdog", "ok", 12_000);
    expect(signals(wd())).toEqual(["system:agent_slowing:warning"]);
  });

  it("watches the hourly rollup like an agent", () => {
    const c = ctx({ schedules: [{ name: "rollup", everyMs: 60 * MIN }], runnerStartedAt: now - 4 * 60 * MIN });
    expect(signals(c)).toEqual(["system:agent_stalled:critical"]);
  });
});

describe("salt rotation", () => {
  const midnight = Date.UTC(2026, 9, 19);
  const staleSalt = () => utimesSync(saltPath, new Date(midnight - 3 * MIN), new Date(midnight - 3 * MIN));

  it("waits 5 minutes after UTC midnight: a stale salt at 00:00:30 is not a finding", () => {
    now = midnight + 30_000;
    staleSalt();
    expect(signals()).toEqual([]);
  });

  it("a salt not rotated by 00:06 is critical", () => {
    now = midnight + 6 * MIN;
    staleSalt();
    expect(run().findings).toMatchObject([{ app_id: null, signal: "salt_rotation_failed", severity: "critical" }]);
  });

  it("a salt rotated after midnight is fine; a missing salt file is critical", () => {
    now = midnight + 6 * MIN;
    utimesSync(saltPath, new Date(midnight + MIN), new Date(midnight + MIN));
    expect(signals()).toEqual([]);
    rmSync(saltPath);
    expect(run().findings[0]!.summary).toMatch(/missing/);
  });
});

describe("disk", () => {
  function samples(points: [number, number][]): void {
    const db = new DatabaseSync(dbPath);
    for (const [ts, bytes] of points) db.prepare("INSERT INTO db_size_samples (ts, bytes) VALUES (?, ?)").run(ts, bytes);
    db.close();
  }

  it("warns by days of disk left at the measured growth rate", () => {
    const fs = statfsSync(dir);
    const free = fs.bavail * fs.bsize;
    // Growing by half the free space per day: about 2 days left.
    samples([[now - DAY, 1_000], [now - 60 * MIN, 1_000 + (free / 2) * (23 / 24)]]);
    expect(run().findings).toMatchObject([{ signal: "disk_filling", severity: "critical" }]);
  });

  it("needs at least an hour of samples, and ignores a shrinking database", () => {
    samples([[now - 30 * MIN, 1_000], [now - MIN, 10 ** 15]]);
    expect(signals()).toEqual([]);
    // An older, larger sample: the database shrank (e.g. after VACUUM).
    samples([[now - 40 * 60 * MIN, 5 * 10 ** 15]]);
    expect(signals()).toEqual([]);
  });

  it("a check that throws is reported on its own and does not hide the others", () => {
    samples([[now - DAY, 1], [now - MIN, 2]]);
    at = now - 10 * MIN;
    store.recordRun({ agent: "watchdog", started_at: at, finished_at: at, outcome: "ok", apps_ok: 0, apps_failed: 0 }, [], []);
    const result = run(ctx({ schedules: WATCHDOG_SCHEDULE, dbPath: join(dir, "no-such-dir", "x.db") }));
    expect(result.findings.map((f) => `${f.signal}:${f.subject}`).sort()).toEqual(["agent_stalled:watchdog", "check_failed:disk"]);
    expect(result.evaluated).toContain(null);
  });
});

let at = 0;

describe("Abigaail restarts", () => {
  /**
   * Record one Watchdog run at `t` exactly as the runner does: findings,
   * evaluated scopes and the run itself. A Health run is recorded too, so the
   * app's status reflects findings rather than "no Health run yet".
   */
  function tick(t: number, startedAt: number, lastRunBeforeStart: number | null): void {
    now = t;
    const c = ctx({ schedules: WATCHDOG_SCHEDULE, runnerStartedAt: startedAt, lastRunBeforeStart });
    const result = evaluate(watchdog, c);
    store.recordRun(
      { agent: "watchdog", started_at: t - 100, finished_at: t, outcome: "ok", apps_ok: result.evaluated.length, apps_failed: 0 },
      findingInputs("watchdog", result),
      result.evaluated,
    );
    store.recordRun({ agent: "health", started_at: t - 100, finished_at: t, outcome: "ok", apps_ok: 1, apps_failed: 0 }, [], []);
  }

  function heartbeat(appId: string, t: number): void {
    store.insertBatch(appId, {
      receivedAt: t,
      release: "r",
      environment: "test",
      events: [{ event: { type: "lifecycle", event_id: id(), client_ts: 1, kind: "heartbeat" }, derived: { ts: t } }],
    });
  }

  // Abigaail runs until T-4 min, is down for 4 minutes, and restarts at T.
  const T = Date.UTC(2026, 9, 19, 10, 0, 0);
  const downFrom = T - 4 * MIN;

  function upUntilOutage(): App {
    const app = appWith("live", every(MIN, downFrom - MIN, 30));
    for (let t = downFrom - 10 * MIN; t <= downFrom; t += MIN) tick(t, downFrom - 60 * MIN, null);
    expect(store.appStatus(app.id, { now: downFrom }).status).toBe("green");
    return app;
  }

  it("Abigaail down 4 min while an app runs: no red after restart, and the app is green once it reconnects", () => {
    const app = upUntilOutage();
    const statuses: string[] = [];
    // The app's SDK backs off and reconnects 5 minutes after the restart.
    for (let t = T + MIN; t <= T + 10 * MIN; t += MIN) {
      if (t >= T + 5 * MIN) heartbeat(app.id, t - 1_000);
      tick(t, T, downFrom);
      statuses.push(store.appStatus(app.id, { now: t }).status);
      expect(store.openFindings(app.id).map((f) => f.signal)).not.toContain("silent");
    }
    expect(statuses).not.toContain("red");
    expect(statuses).not.toContain("amber");
    // Grey while waiting (the app had been quiet past the silent threshold), green once back.
    expect(statuses.slice(0, 3)).toEqual(["grey", "grey", "grey"]);
    expect(statuses.slice(4)).toEqual(Array(6).fill("green"));
    // "reconnecting" is a fact: it resolved on the first run after the app came back.
    const reconnecting = store.findingHistory(app.id).filter((f) => f.signal === "reconnecting");
    expect(reconnecting).toMatchObject([{ state: "resolved", resolved_at: T + 5 * MIN }]);
  });

  it("reports Abigaail's downtime once, as info, and resolves it after the grace period", () => {
    upUntilOutage();
    for (let t = T + MIN; t <= T + 10 * MIN; t += MIN) tick(t, T, downFrom);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT severity, summary, state, hits FROM findings WHERE signal = 'abigaail_down'").all();
    db.close();
    expect(rows).toEqual([{
      severity: "info",
      summary: "Abigaail was down from 2026-10-19 09:56 UTC to 2026-10-19 10:00 UTC (4 min).",
      state: "resolved",
      hits: 7,
    }]);
  });

  it("the first run after a restart does not call any agent stalled because of the outage", () => {
    upUntilOutage();
    tick(T + MIN, T, downFrom);
    expect(store.systemFindings().map((f) => f.signal)).toEqual(["abigaail_down"]);
  });

  it("a short restart (under 3 min) is not reported as downtime", () => {
    upUntilOutage();
    tick(T + MIN, downFrom + 2 * MIN, downFrom);
    expect(store.systemFindings().map((f) => f.signal)).not.toContain("abigaail_down");
  });

  it("an app that never comes back is silent (critical) once the grace period ends", () => {
    const app = upUntilOutage();
    for (let t = T + MIN; t <= T + 9 * MIN; t += MIN) tick(t, T, downFrom);
    // Grace = 5 min SDK backoff + 3 min silent threshold.
    expect(store.openFindings(app.id).map((f) => `${f.signal}:${f.severity}`)).toEqual(["silent:critical"]);
    expect(store.findingHistory(app.id).find((f) => f.signal === "reconnecting")?.state).toBe("resolved");
  });
});

describe("fact-style findings", () => {
  function tick(c: AgentContext): void {
    const result = evaluate(watchdog, c);
    store.recordRun(
      { agent: "watchdog", started_at: c.now - 100, finished_at: c.now, outcome: "ok", apps_ok: 1, apps_failed: 0 },
      findingInputs("watchdog", result),
      result.evaluated,
    );
  }

  it("'never sent an event' resolves on the first run after the app's first event", () => {
    const { app } = store.createApp("new", "test");
    tick(ctx());
    expect(store.openFindings(app.id).map((f) => f.signal)).toEqual(["no_data_yet"]);
    now += MIN;
    store.insertBatch(app.id, {
      receivedAt: now,
      release: "r",
      environment: "test",
      events: [{ event: { type: "lifecycle", event_id: id(), client_ts: 1, kind: "boot" }, derived: { ts: now } }],
    });
    tick(ctx());
    expect(store.openFindings(app.id)).toEqual([]);
    expect(store.findingHistory(app.id)[0]).toMatchObject({ signal: "no_data_yet", state: "resolved", misses: 1 });
  });

  it("'stopped cleanly' resolves on the first run after the app is back", () => {
    const a = appWith("a", [...every(MIN, now - 10 * MIN), { ts: now - 9 * MIN, kind: "shutdown" }]);
    tick(ctx());
    expect(store.openFindings(a.id).map((f) => f.signal)).toEqual(["stopped"]);
    now += MIN;
    store.insertBatch(a.id, {
      receivedAt: now,
      release: "r",
      environment: "test",
      events: [{ event: { type: "lifecycle", event_id: id(), client_ts: 1, kind: "boot" }, derived: { ts: now } }],
    });
    tick(ctx());
    expect(store.openFindings(a.id)).toEqual([]);
  });
});


describe("retention", () => {
  const retention = loadRetention({});
  const about = (c: AgentContext) =>
    run(c).findings.filter((f) => /retention|vacuum/.test(f.signal)).map((f) => `${f.signal}:${f.subject}:${f.severity}`);
  /** A finished retention run (since the runner started, by default an hour ago) that deleted what it could. */
  const retentionRan = (at = now - MIN, behind = false) =>
    store.recordRun({ agent: "retention", started_at: at - 1000, finished_at: at, outcome: "ok", apps_ok: 0, apps_failed: 0, behind }, [], []);

  it("raw events past their period: nothing within 6 h, then warning, then critical after 2 days", () => {
    retentionRan();
    appWith("ok", [{ ts: now - 30 * DAY - 5 * 60 * MIN }]);
    appWith("late", [{ ts: now - 30 * DAY - 7 * 60 * MIN }]);
    appWith("stuck", [{ ts: now - 33 * DAY }]);
    store.disableApp("stuck", "test");
    expect(about(ctx({ retention }))).toEqual(["retention_behind:events:late:warning", "retention_behind:events:stuck:critical"]);
    const f = run(ctx({ retention })).findings.find((x) => x.signal === "retention_behind" && x.subject === "events:stuck")!;
    expect(f.app_id).toBeNull();
    expect(f.summary).toMatch(/Raw events of stuck older than 30 days are still stored: the oldest is 33.0 days old/);
    expect(f.fact).toBe(true);
    // A shorter period in force is judged as such.
    expect(about(ctx({ retention: { ...retention, events: 7 } }))).toContain("retention_behind:events:ok:critical");
    // Without the periods (retention not wired), nothing is judged.
    expect(about(ctx())).toEqual([]);
  });

  it("resolved findings past their period, for apps and for Abigaail itself", () => {
    retentionRan();
    const a = appWith("a", every(MIN, now - MIN));
    const old = now - 180 * DAY - 12 * 60 * MIN;
    const emit = (t: number, app_id: string | null, emitted: boolean) =>
      store.recordRun(
        { agent: "health", started_at: t, finished_at: t, outcome: "ok", apps_ok: 1, apps_failed: 0 },
        emitted ? [{ app_id, agent: "health", fingerprint: "health:x:", signal: "x", severity: "warning", summary: "s", action: "a", evidence: {} }] : [],
        [app_id],
      );
    for (const scope of [a.id, null]) {
      emit(old, scope, true);
      for (let i = 1; i <= 3; i++) emit(old + i, scope, false);
    }
    expect(about(ctx({ retention })).sort()).toEqual(["retention_behind:findings::warning", "retention_behind:findings:a:warning"]);
  });

  it("at startup with old data and a lowered period: nothing before retention's first run finishes, nothing after it caught up", async () => {
    const startedAt = now - 50;
    // Runs from before this start say nothing about this process.
    retentionRan(startedAt - 10 * MIN);
    const a = appWith("a", [{ ts: now - 20 * DAY }, ...every(MIN, now - MIN)]);
    const lowered = { ...retention, events: 7 };
    const c = () => ctx({ retention: lowered, runnerStartedAt: startedAt });
    expect(about(c())).toEqual([]);
    // Retention's first run since the start deletes everything past 7 days.
    const report = await new Retention({ store, days: lowered, now: () => now, log: () => {} }).runOnce();
    expect(report.behind).toBe(false);
    expect(about(c())).toEqual([]);
    expect(store.oldestEventTs(a.id)).toBeGreaterThan(now - 7 * DAY);
  });

  it("while the job reports work left it is a warning, critical only behindCriticalMs after its first run finished", () => {
    const startedAt = now - 60 * MIN;
    appWith("a", [{ ts: now - 40 * DAY }]);
    const c = () => ctx({ retention, runnerStartedAt: startedAt });
    retentionRan(startedAt + MIN, true);
    expect(about(c())).toEqual(["retention_behind:events:a:warning"]);
    // Still behind 2 days after its first run finished: critical.
    now = startedAt + MIN + 2 * DAY + MIN;
    retentionRan(now - MIN, true);
    expect(about(c())).toEqual(["retention_behind:events:a:critical"]);
  });

  it("a job that reports nothing left while old data stays (deletes nothing) is critical at once", () => {
    const startedAt = now - 60 * MIN;
    appWith("a", [{ ts: now - 40 * DAY }]);
    retentionRan(startedAt + MIN, false);
    expect(about(ctx({ retention, runnerStartedAt: startedAt }))).toEqual(["retention_behind:events:a:critical"]);
  });

  it("a database that could not be converted to incremental vacuum is an info finding", () => {
    expect(about(ctx())).toEqual([]);
    store.close();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA auto_vacuum = NONE; VACUUM;");
    db.close();
    store = openStore(dbPath, { now: () => now });
    const found = run(ctx()).findings.filter((f) => f.signal === "vacuum_pending");
    expect(found).toMatchObject([{ app_id: null, severity: "info", fact: true }]);
    expect(found[0]!.summary).toMatch(/cannot shrink yet.*Deleted data is still erased/);
  });

  it("retention that stops running is a stalled job like the rollup", () => {
    const c = ctx({ schedules: [{ name: "retention", everyMs: 60 * MIN }], runnerStartedAt: now - 4 * 60 * MIN });
    expect(signals(c)).toEqual(["system:agent_stalled:critical"]);
    store.recordRun({ agent: "retention", started_at: now - 10 * MIN, finished_at: now - 10 * MIN, outcome: "ok", apps_ok: 0, apps_failed: 0 }, [], []);
    expect(signals(c)).toEqual([]);
  });
});
