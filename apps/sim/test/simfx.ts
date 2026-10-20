// A seeded store per test: history is seeded once per app into a template
// file, then copied, so each scenario starts from the same normal.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@abigaail/store";
import { seedHistory, seedHours, type AppKind } from "@abigaail/sim";

/** Sunday 2026-10-25 03:30 UTC: the quietest hour (the traffic floor), the hardest case for evidence. */
export const QUIET = Date.UTC(2026, 9, 25, 3, 30, 0);
/** Wednesday 2026-10-21 14:30 UTC: the busiest hour. */
export const BUSY = Date.UTC(2026, 9, 21, 14, 30, 0);

const dir = mkdtempSync(join(tmpdir(), "abigaail-sim-"));
const templates = new Map<string, { path: string; appId: string }>();

function template(app: AppKind, start: number): { path: string; appId: string } {
  const key = `${app}-${start}`;
  let t = templates.get(key);
  if (!t) {
    const path = join(dir, `template-${key}.db`);
    const store = openStore(path, { now: () => start });
    const appId = store.createApp(`sim-${app}`, "test").app.id;
    // The hours a test run covers (it starts at :30 and lasts under 90 min).
    seedHistory(store, appId, app, seedHours(start, [-1, 0, 1, 2]));
    store.checkpoint();
    store.close();
    templates.set(key, (t = { path, appId }));
  }
  return t;
}

let n = 0;
export function seededStore(app: AppKind, start: number): { store: Store; appId: string; close: () => void } {
  const t = template(app, start);
  const path = join(dir, `run-${++n}.db`);
  copyFileSync(t.path, path);
  const store = openStore(path, { now: () => start });
  return { store, appId: t.appId, close: () => store.close() };
}

export function cleanup(): void {
  rmSync(dir, { recursive: true, force: true });
}
