// Seeded history for the simulator's own database (never the real one).
// Baselines need the same hour on past weeks or days (DECISIONS #49), and
// ingest refuses events older than 24 h, so history is written through the
// Store directly: every batch is first checked with the server's
// validateBatch, then stored and rolled up exactly as the runner would.

import { validateBatch } from "@abigaail/schema/validate";
import { HOUR_MS, type Store } from "@abigaail/store";
import { requestItems, wireBatch, ENVIRONMENT, type Item } from "./events.js";
import { NORMAL_FAULTS, outcome } from "./model.js";
import { rng } from "./random.js";
import { DAY, generate, WEEK, type AppKind } from "./traffic.js";

/** Release of the seeded history and of the live run's first boot. */
export const FIRST_RELEASE = "sim-r1";
/** Hours around now the run may cover, seeded on past weeks and days. */
export const LIVE_OFFSETS: readonly number[] = [-1, 0, 1, 2, 3, 4, 5, 6];
const WEEKS = 4;
const DAYS = 7;
const BATCH = 500;

/** Past hours to seed: each offset hour on the last 4 weeks and the last 7 days, oldest first. */
export function seedHours(now: number, offsets: readonly number[] = LIVE_OFFSETS): number[] {
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;
  const hours = new Set<number>();
  for (const o of offsets) {
    const h = current + o * HOUR_MS;
    for (let k = 1; k <= WEEKS; k++) hours.add(h - k * WEEK);
    for (let d = 1; d <= DAYS; d++) hours.add(h - d * DAY);
  }
  return [...hours].filter((h) => h < current).sort((a, b) => a - b);
}

/** Validate, then store, one batch. Throws (naming fields, never values) if it is invalid. */
export function insertValidated(store: Store, appId: string, release: string, items: readonly Item[], receivedAt: number): void {
  const check = validateBatch(wireBatch(release, items));
  if (!check.ok) throw new Error(`seeded batch rejected: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  store.insertBatch(appId, { receivedAt, release, environment: ENVIRONMENT, events: [...items] });
}

/** Seed normal human traffic for the given hours and roll each one up. Returns the number of events. */
export function seedHistory(store: Store, appId: string, app: AppKind, hours: readonly number[], seed = 1): number {
  const r = rng(seed);
  let total = 0;
  for (const hour of hours) {
    const items = generate(r, app, hour, hour + HOUR_MS, { humans: true, bots: 0, extra: [] })
      .flatMap((req) => requestItems(r, req, outcome(r, app, req.path, NORMAL_FAULTS)))
      .filter((i) => i.derived.ts < hour + HOUR_MS);
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      insertValidated(store, appId, FIRST_RELEASE, slice, Math.max(...slice.map((s) => s.derived.ts)));
    }
    store.rollupHour(appId, hour);
    total += items.length;
  }
  return total;
}
