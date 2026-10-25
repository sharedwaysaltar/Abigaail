// app:purge (DECISIONS #126): delete every row of one app, on request (the
// GDPR deletion path), while the server keeps running.
//
// The app must be disabled first, so ingest cannot write while it runs. Rows
// go in short batches (as retention), with a pause between them so the
// server's ingest, agents and alerter take the write lock in turn. Every step
// is idempotent and the apps row goes last, so a run that is interrupted is
// finished by running it again. The last step (Store.finishPurge) deletes, in
// one transaction, anything written meanwhile, Abigaail's own findings that
// name the app, and the apps row; it is audited with counts only. Then the
// bytes are erased: secure_delete has zeroed them, incremental vacuum returns
// the freed pages and the WAL is truncated. Copies of the app's cells that
// earlier page splits left in the unused space of pages still in use are
// beyond secure_delete: only a VACUUM removes them, and a VACUUM blocks every
// writer, so the purge leaves it owed and the server runs it at its next
// start, before ingest listens (vacuumIfOwed).

import { setTimeout as sleep } from "node:timers/promises";
import { PURGE_DELETE, type App, type PurgeCounts, type PurgeTable, type PurgeTotals, type Store } from "@abigaail/store";
import { errorClass } from "./agents/evaluate.js";
import { appNamedFingerprints } from "./agents/watchdog.js";
import { PURGE, RETENTION } from "./agents/thresholds.js";
import { truncateWal } from "./retention.js";

export interface PurgeOptions {
  store: Store;
  app: App;
  actor?: string;
  batchRows?: number;
  pauseMs?: number;
  /** Progress lines (table names and counts only). */
  log?: (msg: string) => void;
  /** Called after each batch (tests: interrupt or write in between). */
  onBatch?: (table: PurgeTable, deleted: number) => void | Promise<void>;
  /** Stops the purge between batches (Ctrl-C). */
  signal?: AbortSignal;
  checkpointRetryMs?: number;
}

/** What purging the app would delete. */
export function purgePlan(store: Store, app: App): PurgeCounts {
  return store.purgeCounts(app.id, appNamedFingerprints(app.name));
}

/** Total rows of a plan or report. */
export function purgeTotal(c: PurgeCounts): number {
  return Object.values(c.tables).reduce((a, b) => a + b, 0) + c.system_rows;
}

/** Thrown by purgeApp when its signal stops it between batches. */
export class PurgeInterrupted extends Error {
  override name = "PurgeInterrupted";
  constructor(readonly sofar: PurgeCounts) {
    super("purge interrupted");
  }
}

/**
 * Purge one disabled app. Throws AppEnabled for an enabled app (nothing is
 * deleted). `signal` stops it between batches: the run is audited as
 * app.purge_interrupted with what is deleted so far and PurgeInterrupted is
 * thrown; an error is audited the same way and rethrown. Running it again
 * resumes. Returns the totals over every run.
 */
export async function purgeApp(o: PurgeOptions): Promise<PurgeTotals> {
  const { store, app } = o;
  const actor = o.actor ?? "cli";
  const batchRows = o.batchRows ?? PURGE.batchRows;
  const pauseMs = o.pauseMs ?? PURGE.pauseMs;
  const log = o.log ?? (() => {});
  const fingerprints = appNamedFingerprints(app.name);

  store.startPurge(app.id, actor, store.purgeCounts(app.id, fingerprints));
  try {
    for (const table of PURGE_DELETE) {
      let deleted = 0;
      for (;;) {
        if (o.signal?.aborted) throw new PurgeInterrupted(store.purgeProgress(app.id));
        const n = table === "alert_items"
          ? store.purgeAlerts(app.id, app.name, PURGE.alertBatch).items
          : store.purgeBatch(table, app.id, batchRows);
        deleted += n;
        await o.onBatch?.(table, n);
        if (n === 0) break;
        await sleep(pauseMs);
      }
      if (deleted) log(`${table}: ${deleted} deleted`);
    }
  } catch (err) {
    const interrupted = err instanceof PurgeInterrupted;
    try {
      const sofar = store.interruptPurge(app.id, actor, interrupted ? "signal" : "error");
      if (interrupted) throw new PurgeInterrupted(sofar);
    } catch (auditErr) {
      if (auditErr instanceof PurgeInterrupted) throw auditErr;
      log(`could not record the interruption (${errorClass(auditErr)})`);
    }
    throw err;
  }

  const total = store.finishPurge(app.id, app.name, fingerprints, actor);

  // Erase: freed pages back to the filesystem, then no old page image left in the WAL.
  while (store.incrementalVacuum(RETENTION.vacuumPages) > 0) await sleep(pauseMs);
  await truncateWal(store, "the WAL", o.checkpointRetryMs);
  return total;
}

/**
 * Finish what app:purge could not do live: one VACUUM, at startup before
 * ingest listens, when a purge left it owed. Logs only; never throws (still
 * owed, it is tried at the next start, and the Watchdog says so meanwhile).
 */
export function vacuumIfOwed(
  store: Pick<Store, "vacuumIfOwed">,
  log: (msg: string) => void,
  opts: { freeBytes?: (dir: string) => number } = {},
): void {
  try {
    const result = store.vacuumIfOwed(opts);
    if (!result) return;
    if (result.status === "converted") {
      log(`database: VACUUM after app:purge in ${result.ms} ms; the purged apps' bytes are gone from the file`);
    } else {
      log(`database: VACUUM after app:purge skipped: needs ${(result.needBytes / 1e6).toFixed(1)} MB free, ${(result.freeBytes / 1e6).toFixed(1)} MB free. ` +
        "Free space and restart to finish erasing");
    }
  } catch (err) {
    log(`database: VACUUM after app:purge failed (${errorClass(err)}); tried again at the next start`);
  }
}

export interface PurgeCommandDeps {
  store: Store;
  /** One line typed by the operator. */
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
  /** Called once the name is confirmed, just before deleting: the signal Ctrl-C aborts from then on. */
  armStop?: () => AbortSignal;
  /** Overrides for tests. */
  purge?: Partial<Omit<PurgeOptions, "store" | "app">>;
}

function printCounts(c: PurgeCounts, print: (line: string) => void): void {
  for (const [table, n] of Object.entries(c.tables)) print(`  ${table.padEnd(18)} ${n}`);
  print(`  alert messages     ${c.deliveries_deleted} deleted, ${c.deliveries_rewritten} kept without this app's items`);
  print(`  Abigaail's own     ${c.system_rows} finding/alert rows that name the app`);
}

/**
 * `npm run app:purge -- <name> [--dry-run]`. Dry run: counts only, on any app,
 * changes nothing and is not audited. Otherwise the app must be disabled and
 * its name typed again. Returns the exit code.
 */
export async function runPurgeCommand(args: readonly string[], deps: PurgeCommandDeps): Promise<number> {
  const { store, print } = deps;
  const dry = args.includes("--dry-run");
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    print("usage: npm run app:purge -- <name> [--dry-run]");
    return 1;
  }
  const app = store.appByName(name);
  if (!app) {
    print(`no app named "${name}"`);
    return 1;
  }
  const plan = purgePlan(store, app);
  if (dry) {
    print(`Dry run: purging "${name}" would delete:`);
    printCounts(plan, print);
    if (app.disabled_at === null) print(`"${name}" is enabled: disable it first (npm run app:disable -- ${name}).`);
    return 0;
  }
  if (app.disabled_at === null) {
    print(`"${name}" is enabled. Disable it first, so ingest cannot write while it is purged: npm run app:disable -- ${name}`);
    return 1;
  }
  const resuming = store.purgeStarted(app.id);
  print(`${resuming ? "Resuming the purge of" : "Purging"} "${name}" deletes, for good:`);
  printCounts(plan, print);
  print("Audit log entries about the app are kept (counts only). Alerts already delivered cannot be recalled.");
  const typed = (await deps.ask("Type the app name again to delete all its data: ")).trim();
  if (typed !== name) {
    print("The name does not match; nothing was deleted.");
    return 1;
  }
  let total: PurgeTotals;
  try {
    const signal = deps.armStop?.();
    total = await purgeApp({ store, app, log: (m) => print(`  ${m}`), ...(signal ? { signal } : {}), ...deps.purge });
  } catch (err) {
    if (!(err instanceof PurgeInterrupted)) throw err;
    print(`Interrupted: ${purgeTotal(err.sofar)} rows deleted so far. Run the same command again to finish.`);
    return 130;
  }
  const runs = total.resumed ? ` over ${total.resumed + 1} runs` : "";
  print(`Purged "${name}": ${purgeTotal(total)} rows deleted${runs}, the app removed, the freed space erased.`);
  print("Restart the Abigaail server to finish now: it runs a VACUUM at startup, before ingest listens, to erase copies " +
    "of the app's rows that SQLite left in the unused space of pages still in use. Otherwise the weekly VACUUM does it within 7 days.");
  return 0;
}
