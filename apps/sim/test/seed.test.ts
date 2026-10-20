// Seeded history: every batch passes the server's validation before it is
// stored, and the hours seeded give Health an hour-of-week baseline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineSlots } from "@abigaail/insights";
import { HOUR_MS, openStore, type Store } from "@abigaail/store";
import { insertValidated, lifecycleItem, rng, seedHistory, seedHours, WEEK, DAY } from "@abigaail/sim";

let dir: string;
let store: Store;
let appId: string;
const NOW = Date.UTC(2026, 9, 21, 14, 30);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-seed-"));
  store = openStore(join(dir, "t.db"), { now: () => NOW });
  appId = store.createApp("sim-node", "test").app.id;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("seeding", () => {
  it("seeds the same hour on the last 4 weeks and 7 days, all in the past", () => {
    const hours = seedHours(NOW, [0]);
    const h = Math.floor(NOW / HOUR_MS) * HOUR_MS;
    expect(hours).toEqual([4, 3, 2].map((k) => h - k * WEEK).concat([7, 6, 5, 4, 3, 2, 1].map((d) => h - d * DAY)));
  });

  it("gives Health an hour-of-week baseline", () => {
    seedHistory(store, appId, "node", seedHours(NOW, [0]));
    expect(baselineSlots(store, appId, NOW - 45_000).source).toBe("hour-of-week");
    expect(store.countEvents(appId, { type: "outbound" })).toBeGreaterThan(0);
  }, 60_000); // seeds ~10 hours of history: seconds, more on a busy runner

  it("refuses a batch the server would refuse, and stores nothing of it", () => {
    const bad = lifecycleItem(rng(1), NOW - DAY, "heartbeat");
    (bad.event as unknown as Record<string, unknown>).email = "x";
    expect(() => insertValidated(store, appId, "sim-r1", [bad], NOW - DAY)).toThrow(/field not allowed: email/);
    const region = lifecycleItem(rng(2), NOW - DAY, "heartbeat");
    (region.event as unknown as Record<string, unknown>).region = "LON1";
    expect(() => insertValidated(store, appId, "sim-r1", [region], NOW - DAY)).toThrow(/region/);
    expect(store.countEvents(appId)).toBe(0);
  });
});
