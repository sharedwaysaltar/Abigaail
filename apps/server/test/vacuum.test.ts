// The weekly VACUUM (DECISIONS #129): deleted data leaves the file within 7
// days. The slot is the quietest hour, the VACUUM runs from the retention job,
// a byte scan after retention and the VACUUM finds no deleted value, ingest
// during the VACUUM loses no batch (the SDK retries), and the Watchdog warns
// when it is skipped or overdue.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, evaluate, loadRetention, openSaltFile, Retention, thresholds, watchdog, weeklyVacuumSlot, type AgentContext, type RetentionOptions } from "@abigaail/server";
import { HOUR_MS, openStore, type Store } from "@abigaail/store";

const { RETENTION } = thresholds;
const MIN = 60_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Sunday 2026-10-25 10:30 UTC. */
const T0 = Date.UTC(2026, 9, 25, 10, 30, 0);

let dir: string;
let path: string;
let now: number;
let store: Store;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-vacuum-"));
  path = join(dir, "abigaail.db");
  now = T0;
  store = openStore(path, { now: () => now });
  logs = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const job = (o: Partial<RetentionOptions> = {}) =>
  new Retention({ store, days: loadRetention({}), now: () => now, log: (m) => logs.push(m), checkpointRetryMs: 1, ...o });

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const marker = (s: string) => `zz${s}q9`;
let seed = 1;
/** A UUID-shaped id from a fixed pseudo-random sequence. */
function seededId(): string {
  let hex = "";
  for (let i = 0; i < 4; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    hex += seed.toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** `count` requests of one app in the hour starting at `hour`, `tag` planted in route and visitor hash. */
function requests(appId: string, hour: number, count: number, tag: string): void {
  const events = Array.from({ length: count }, (_, i) => {
    const ts = hour + Math.floor((HOUR_MS * i) / count);
    return {
      // Spread over the key space, as the SDK's random ids are (seeded here, so the page layout is the same every run).
      event: { type: "request" as const, event_id: seededId(), client_ts: ts, method: "GET" as const, route: `/${marker(`${tag}route`)}`, status: 200, duration_ms: 5 + (i % 9) },
      derived: { ts, bot_class: "human" as const, visitor_hash: marker(`${tag}v${i}`), browser: null },
    };
  });
  store.insertBatch(appId, { receivedAt: hour + HOUR_MS - 1, release: "r1", environment: "test", events });
}

const files = () => [path, `${path}-wal`].filter(existsSync).map((f) => readFileSync(f));
const copies = (s: string) => files().reduce((total, f) => {
  let k = 0;
  for (let i = f.indexOf(s); i >= 0; i = f.indexOf(s, i + 1)) k++;
  return total + k;
}, 0);

const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;

describe("the slot", () => {
  /** Traffic per hour start: busy everywhere except the given hour-of-week slots. */
  const quietAt = (...slots: number[]) => (hour: number) => (slots.some((q) => ((hour - q) % WEEK + WEEK) % WEEK === 0) ? 1 : 100);

  it("is the quietest hour of the last day before a week is up, from the same hours of the past 4 weeks", () => {
    const last = hourOf(T0) + 30 * MIN;
    const quiet = hourOf(T0) + 7 * DAY - 9 * HOUR_MS;
    expect(weeklyVacuumSlot(last, quietAt(quiet))).toBe(quiet);
    // A steady week: the same hour every week.
    const run = quiet + RETENTION.runAtMinute * MIN;
    expect(weeklyVacuumSlot(run, quietAt(quiet))).toBe(quiet + WEEK);
  });

  it("is never later than 7 days after the last VACUUM, quiet hours further out are not waited for", () => {
    for (const offset of [0, 7, 13, 29, 59]) {
      const last = T0 + offset * MIN;
      const slot = weeklyVacuumSlot(last, quietAt(hourOf(last) + 8 * DAY));
      expect(slot + RETENTION.runAtMinute * MIN).toBeLessThanOrEqual(last + WEEK);
      expect(slot + RETENTION.runAtMinute * MIN).toBeGreaterThan(last + 6 * DAY);
    }
  });

  it("with no traffic data (or a tie) the earliest hour of the day", () => {
    const last = hourOf(T0) + 30 * MIN;
    expect(weeklyVacuumSlot(last, () => 0)).toBe(hourOf(T0) + 6 * DAY + HOUR_MS);
  });

  it("all apps combined: the hour quiet across the apps, not the one quiet in one of them", async () => {
    const a = store.createApp("a", "test").app.id;
    const b = store.createApp("b", "test").app.id;
    job(); // starts the clock at T0
    const day = hourOf(T0) + 6 * DAY + HOUR_MS;
    // Over the past 4 weeks: hour +3 quiet in a only, hour +5 quiet in both, everything else busy in both.
    for (let k = 1; k <= 4; k++) {
      for (let h = 0; h < 24; h++) {
        const hour = day + h * HOUR_MS - k * WEEK;
        requests(a, hour, h === 3 || h === 5 ? 1 : 20, "a");
        requests(b, hour, h === 5 ? 1 : 20, "b");
        store.rollupHour(a, hour);
        store.rollupHour(b, hour);
      }
    }
    const slot = day + 5 * HOUR_MS;
    now = slot - 30 * MIN;
    await job().runOnce();
    expect(logs.filter((l) => l.includes("weekly VACUUM"))).toEqual([]);
    now = slot + RETENTION.runAtMinute * MIN;
    await job().runOnce();
    expect(logs.filter((l) => l.includes("weekly VACUUM"))).toEqual([expect.stringMatching(/^retention: weekly VACUUM in \d+ ms/)]);
    expect(store.lastVacuumAt()).toBe(now);
    // The catch-up runs of the same hour do not run it again.
    now += 5 * MIN;
    await job().runOnce();
    expect(logs.filter((l) => l.includes("weekly VACUUM"))).toHaveLength(1);
  });
});

describe("in the retention job", () => {
  it("overdue (the server was down at its hour): runs at once", async () => {
    job();
    now = T0 + 9 * DAY;
    await job().runOnce();
    expect(logs).toContainEqual(expect.stringMatching(/^retention: weekly VACUUM in \d+ ms/));
    expect(store.lastVacuumAt()).toBe(now);
  });

  it("without room: skipped, logged once, warned about by the Watchdog, tried every run until it fits", async () => {
    job();
    now = T0 + 8 * DAY;
    const tight = job({ freeBytes: () => 0 });
    await tight.runOnce();
    now += HOUR_MS;
    await tight.runOnce();
    expect(logs.filter((l) => l.includes("weekly VACUUM"))).toEqual([expect.stringMatching(/^retention: weekly VACUUM skipped: needs .* MB free, 0.0 MB free/)]);
    expect(store.vacuumNoRoomSince()).toBe(T0 + 8 * DAY);
    expect(watchdogSignals()).toEqual(["vacuum_skipped:warning"]);
    now += HOUR_MS;
    await job().runOnce();
    expect(store.vacuumNoRoomSince()).toBeUndefined();
    expect(store.lastVacuumAt()).toBe(now);
    expect(watchdogSignals()).toEqual([]);
  });

  it("the Watchdog warns when it has not run for over a week", () => {
    job();
    now = T0 + 7 * DAY;
    expect(watchdogSignals()).toEqual([]);
    now = T0 + 7 * DAY + HOUR_MS + MIN;
    expect(watchdogSignals()).toEqual(["erasure_overdue:warning"]);
  });
});

function watchdogSignals(): string[] {
  const ctx: AgentContext = {
    store,
    apps: store.listApps(),
    now,
    windowEnd: now - 45_000,
    config: { dbPath: path, saltPath: join(dir, "salt.bin"), schedules: [], runnerStartedAt: now - HOUR_MS, lastRunBeforeStart: null },
  };
  return evaluate(watchdog, ctx).findings.filter((f) => /vacuum|erasure/.test(f.signal) && f.signal !== "vacuum_pending").map((f) => `${f.signal}:${f.severity}`);
}

describe("the bytes are gone within the week", () => {
  /** Copies of the deleted rows' visitor hashes: only raw events hold them (rollups keep counts). */
  const oldHashes = () => Array.from({ length: 200 }, (_, i) => copies(marker(`oldv${i}`))).reduce((a, b) => a + b, 0);

  it("rows retention deletes can leave copies in unused space; the weekly VACUUM removes every one", async () => {
    seed = 1;
    const a = store.createApp("a", "test").app.id;
    const old = hourOf(T0 - 40 * DAY);
    const recent = hourOf(T0 - 2 * HOUR_MS);
    // Old rows among rows that stay (one app: they interleave in key order).
    for (let i = 0; i < 6; i++) {
      requests(a, old + i * HOUR_MS, 200, "old");
      requests(a, recent - i * HOUR_MS, 200, `keep${i}`);
    }
    store.checkpoint();
    expect(oldHashes()).toBeGreaterThanOrEqual(1200);
    job(); // the weekly clock starts now
    // Small batches, as on a busy server: pages merge while old rows are still waiting to go.
    const report = await job({ batchRows: 7 }).runOnce();
    expect(report.deleted.events).toBe(1200);
    // secure_delete zeroed every deleted row, but copies made when pages merged remain in unused space.
    expect(oldHashes()).toBeGreaterThan(0);
    // A week later, at its hour: the VACUUM.
    now = T0 + WEEK;
    await job().runOnce();
    expect(logs).toContainEqual(expect.stringMatching(/^retention: weekly VACUUM in \d+ ms/));
    expect(oldHashes()).toBe(0);
    expect(copies(marker("keep0v7"))).toBe(1);
  });
});

describe("ingest during the VACUUM", () => {
  it("loses no batch: requests wait, the SDK retries those that time out, event ids drop the repeats", async () => {
    const salt = openSaltFile(join(dir, "salt.bin"));
    const live = openStore(path);
    // No rate limit in the way: the only failed sends are the ones the VACUUM held up.
    const server = createServer({ store: live, salt, log: () => {}, appRate: { perSec: 10_000, burst: 10_000 } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { key } = live.createApp("sender", "test");
      const app = live.appByName("sender")!;
      // Enough data that the VACUUM blocks the server well past the SDK's timeout.
      const filler = live.createApp("filler", "test").app.id;
      for (let h = 0; h < 30; h++) {
        const events = Array.from({ length: 2000 }, (_, i) => ({
          event: { type: "request" as const, event_id: id(), client_ts: Date.now(), method: "GET" as const, route: "/" + "x".repeat(200), status: 200, duration_ms: i % 50 },
          derived: { ts: Date.now() - h * MIN, bot_class: "human" as const, visitor_hash: `v${i}`, browser: null },
        }));
        live.insertBatch(filler, { receivedAt: Date.now(), release: "r1", environment: "test", events });
      }
      live.checkpoint();

      const COUNT = 150;
      const port = (server.address() as AddressInfo).port;
      const child = spawn(process.execPath, [
        "--experimental-transform-types", "--no-warnings",
        "--import", fileURLToPath(new URL("./fixtures/ts-sources.mjs", import.meta.url)),
        fileURLToPath(new URL("./fixtures/sdk-sender.mjs", import.meta.url)),
        `http://127.0.0.1:${port}/ingest`, key, String(COUNT), "5", "50",
      ], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

      // Once the sender is under way, block this thread with the VACUUM, as the server's weekly one does.
      const deadline = Date.now() + 20_000;
      while (live.countEvents(app.id) < 20 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(live.countEvents(app.id)).toBeGreaterThanOrEqual(20);
      const result = live.fullVacuum();
      expect(result).toMatchObject({ status: "converted" });
      // Longer than the SDK's 50 ms timeout, so a send in flight times out.
      expect((result as { ms: number }).ms).toBeGreaterThan(50);

      expect(await exited).toBe(0);
      const stats = JSON.parse(out) as { sent: number; failedSends: number; dropped: number; queued: number };
      // A send timed out during the VACUUM and was sent again.
      expect(stats.failedSends).toBeGreaterThan(0);
      expect(stats).toMatchObject({ queued: 0, dropped: 0 });
      const values = live.recentEvents(app.id, 1000).filter((e) => e.type === "metric").map((e) => (e as { value: number }).value).sort((x, y) => x - y);
      expect(values).toEqual(Array.from({ length: COUNT }, (_, i) => i));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      live.close();
    }
  }, 60_000);
});
