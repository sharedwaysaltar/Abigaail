import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRetention, Runner, thresholds, type RunnerOptions } from "@abigaail/server";
import { HOUR_MS, openStore, type Store } from "@abigaail/store";

const fixture = (name: string) => new URL(`./fixtures/${name}.mjs`, import.meta.url);

let dir: string;
let dbPath: string;
let store: Store;
let runner: Runner | undefined;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-runner-"));
  dbPath = join(dir, "test.db");
  store = openStore(dbPath);
  logs = [];
});

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRunner(workers: Record<string, string>, opts: Partial<RunnerOptions> = {}): Runner {
  runner = new Runner({
    store,
    dbPath,
    agents: Object.keys(workers).map((name) => ({ name, everyMs: 60_000, timeoutMs: 500 })),
    workerUrl: (name) => fixture(workers[name]!),
    log: (m) => logs.push(m),
    ...opts,
  });
  return runner;
}

describe("runner isolation", () => {
  it("terminates a looping agent at its timeout while another agent still completes", async () => {
    const r = makeRunner({ looping: "loop", good: "finding" });
    const t0 = Date.now();
    const [looping, good] = await Promise.all([r.runAgent("looping"), r.runAgent("good")]);
    expect(looping.run).toMatchObject({ outcome: "timeout", error_class: "Timeout" });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(good.run.outcome).toBe("ok");
    expect(store.systemFindings()).toMatchObject([{ agent: "good", fingerprint: "good:x:s", severity: "warning" }]);
    expect(store.recentRuns("looping")[0]).toMatchObject({ outcome: "timeout" });
  });

  it("logs a crashing agent as an error with its class name only", async () => {
    const r = makeRunner({ crashing: "throw" });
    const { run } = await r.runAgent("crashing");
    expect(run).toMatchObject({ outcome: "error", error_class: "TypeError" });
    expect(store.recentRuns("crashing")[0]).toMatchObject({ outcome: "error", error_class: "TypeError" });
    expect(logs.join("\n")).not.toMatch(/4111|jane/);
  });

  it("rejects a malformed result without writing findings", async () => {
    const r = makeRunner({ odd: "bad" });
    expect((await r.runAgent("odd")).run).toMatchObject({ outcome: "error", error_class: "BadResult" });
    expect(store.systemFindings()).toEqual([]);
  });

  it("never overlaps an agent with itself: the second start is logged as skipped", async () => {
    const r = makeRunner({ slow: "finding" });
    const [first, second] = await Promise.all([r.runAgent("slow"), r.runAgent("slow")]);
    expect(first.run.outcome).toBe("ok");
    expect(second.run.outcome).toBe("skipped");
    expect(store.recentRuns("slow").map((x) => x.outcome).sort()).toEqual(["ok", "skipped"]);
  });

  it("a timed-out run leaves earlier findings open (misses never advance)", async () => {
    const r = makeRunner({ flaky: "finding" });
    await r.runAgent("flaky");
    const looping = makeRunner({ flaky: "loop" });
    for (let i = 0; i < 3; i++) await looping.runAgent("flaky");
    expect(store.systemFindings()).toMatchObject([{ fingerprint: "flaky:x:s", misses: 0 }]);
  });
});

describe("restart after a gap", () => {
  it("continues findings after a short restart, but closes them as not observed after a long one", async () => {
    let clock = Date.UTC(2026, 9, 20, 9, 0, 0);
    const now = () => clock;
    let r = makeRunner({ good: "finding" }, { now });
    await r.runAgent("good");
    clock += 60_000;
    await r.runAgent("good");
    const first = store.systemFindings()[0]!;
    expect(first.hits).toBe(2);

    // Down for 2 min: within the resolve window (3 runs of 1 min), so the same finding goes on.
    clock += 2 * 60_000;
    r = makeRunner({ good: "finding" }, { now });
    expect(store.systemFindings().map((f) => f.id)).toEqual([first.id]);
    await r.runAgent("good");
    expect(store.systemFindings()[0]).toMatchObject({ id: first.id, hits: 3 });

    // Down for 10 min: nobody saw it, so it is closed as not observed and found again fresh.
    clock += 10 * 60_000;
    r = makeRunner({ good: "finding" }, { now });
    expect(store.systemFindings()).toEqual([]);
    expect(logs).toContain("good: 1 open finding closed as not observed while Abigaail was down");
    await r.runAgent("good");
    const [fresh] = store.systemFindings();
    expect(fresh!.id).not.toBe(first.id);
    expect(fresh).toMatchObject({ hits: 1, first_seen: clock });
  });
});

describe("the cooldown never reaches across unobserved downtime", () => {
  it("a finding resolved normally before a long gap starts fresh after it; a short restart still reopens it", async () => {
    let clock = Date.UTC(2026, 9, 20, 9, 0, 0);
    const now = () => clock;
    const emitting = () => makeRunner({ good: "finding" }, { now });
    const quiet = () => makeRunner({ good: "clean" }, { now });

    // "good" emits the finding with the finding fixture and nothing with the clean one.
    // Open, held for 2 runs, then resolved normally by 3 quiet runs.
    let r = emitting();
    await r.runAgent("good");
    clock += 60_000;
    await r.runAgent("good");
    const old = store.systemFindings()[0]!;
    r = quiet();
    for (let k = 0; k < 3; k++) {
      clock += 60_000;
      await r.runAgent("good");
    }
    expect(store.systemFindings()).toEqual([]);

    // Down 7 min: longer than the resolve window (3 min), shorter than the 30 min cooldown.
    clock += 7 * 60_000;
    r = emitting();
    await r.runAgent("good");
    const [fresh] = store.systemFindings();
    expect(fresh!.id).not.toBe(old.id);
    expect(fresh).toMatchObject({ hits: 1, first_seen: clock });
    // The old one keeps its ordinary resolution.
    const raw = (store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db
      .prepare("SELECT state, resolved_reason FROM findings WHERE id = ?").get(old.id);
    expect(raw).toEqual({ state: "resolved", resolved_reason: null });

    // A short restart (2 min, within the window): the cooldown reopens as before.
    r = quiet();
    for (let k = 0; k < 3; k++) {
      clock += 60_000;
      await r.runAgent("good");
    }
    expect(store.systemFindings()).toEqual([]);
    clock += 2 * 60_000;
    r = emitting();
    await r.runAgent("good");
    expect(store.systemFindings()[0]!.id).toBe(fresh!.id);
  });
});

describe("healthz liveness", () => {
  it("is fresh at start, stale after 3 minutes without a Watchdog run, fresh again after one", async () => {
    let now = Date.now();
    const r = makeRunner({ watchdog: "finding" }, { now: () => now });
    expect(r.watchdogFresh()).toBe(true);
    now += thresholds.WATCHDOG.healthzStaleMs + 1;
    expect(r.watchdogFresh()).toBe(false);
    await r.runAgent("watchdog");
    expect(r.watchdogFresh()).toBe(true);
  });

  it("a failing Watchdog does not count as alive", async () => {
    let now = Date.now();
    const r = makeRunner({ watchdog: "throw" }, { now: () => now });
    now += thresholds.WATCHDOG.healthzStaleMs + 1;
    await r.runAgent("watchdog");
    expect(r.watchdogFresh()).toBe(false);
  });
});

describe("rollup maintenance", () => {
  it("runOnce rolls up and backfills closed hours, and logs a rollup run", async () => {
    const now = Date.now();
    const closedEnd = Math.floor((now - thresholds.EVAL_LAG_MS) / HOUR_MS) * HOUR_MS;
    const { app } = store.createApp("a", "test");
    // Pretend the app is 10 hours old, with one request 6 hours ago.
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE apps SET created_at = ? WHERE id = ?")
      .run(closedEnd - 10 * HOUR_MS, app.id);
    const sixAgo = closedEnd - 6 * HOUR_MS;
    store.insertBatch(app.id, {
      receivedAt: sixAgo + 1000,
      release: "r",
      environment: "test",
      events: [{
        event: { type: "request", event_id: "00000000-0000-4000-8000-000000000001", client_ts: 1, method: "GET", route: "/x", status: 200, duration_ms: 5 },
        derived: { ts: sixAgo + 1000, bot_class: "human" },
      }],
    });
    const r = makeRunner({});
    await r.runOnce();
    expect(store.missingHours(app.id, closedEnd - 10 * HOUR_MS, closedEnd)).toEqual([]);
    expect(store.hourly(app.id, "route", [sixAgo])).toMatchObject([{ key: "/x", n: 1 }]);
    expect(store.recentRuns("rollup")[0]).toMatchObject({ outcome: "ok" });
    expect(store.dbSizeSamples(0)).toHaveLength(1);
  });
});

describe("backfill and retention", () => {
  it("never backfills hours whose raw events are past the retention period", async () => {
    const now = Date.UTC(2026, 9, 20, 12, 30);
    const { app } = store.createApp("a", "test");
    // An app created 40 days ago that has never been rolled up.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE apps SET created_at = ? WHERE id = ?").run(now - 40 * 86_400_000, app.id);
    db.close();
    const r = makeRunner({}, { now: () => now, retention: { ...loadRetention({}), events: 7 } });
    await r.runOnce();
    const DAY = 86_400_000;
    const floor = Math.ceil((now - 7 * DAY) / HOUR_MS) * HOUR_MS;
    expect(store.missingHours(app.id, floor, now - 4 * HOUR_MS)).toEqual([]);
    // Older hours stay unrolled: retention rolls each one up itself just before deleting it.
    expect(store.missingHours(app.id, now - 28 * DAY, floor)).toHaveLength((floor - Math.ceil((now - 28 * DAY) / HOUR_MS) * HOUR_MS) / HOUR_MS);
  });
});
