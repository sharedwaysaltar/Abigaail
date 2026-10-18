import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runner, thresholds, type RunnerOptions } from "@abigaail/server";
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
