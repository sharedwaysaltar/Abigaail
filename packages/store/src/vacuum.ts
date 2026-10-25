// Physical erasure helpers shared by the monitoring and auth databases
// (DECISIONS #89). secure_delete (openWritable) zeroes deleted content; the
// WAL checkpoint moves the zeroed pages into the main file and truncates the
// WAL, so old page images do not survive there; incremental vacuum returns
// freed pages to the filesystem so the file shrinks.

import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Free disk needed to convert a database to incremental auto_vacuum, as a
 * multiple of its file plus WAL. VACUUM writes a temp copy of the live content
 * and then the whole rebuilt database into the WAL, so the peak is about twice
 * the live content (measured: 220 MB extra for a 157 MB file with 30% free
 * pages); a file with no free pages needs 2x, plus a margin.
 */
export const VACUUM_SPACE_FACTOR = 2.2;

/** PRAGMA auto_vacuum: 0 none, 1 full, 2 incremental. */
export const AUTO_VACUUM_INCREMENTAL = 2;

export type VacuumConversion =
  | { status: "already" }
  | { status: "converted"; ms: number; bytesBefore: number; bytesAfter: number }
  | { status: "no_space"; needBytes: number; freeBytes: number };

export function autoVacuumMode(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum);
}

export function freelistCount(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
}

export function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/** Bytes available to this user on the filesystem holding `dir`. */
export function freeBytesAt(dir: string): number {
  const fs = statfsSync(dir);
  return fs.bavail * fs.bsize;
}

/**
 * One-time switch of an existing file to incremental auto_vacuum, which needs a
 * VACUUM. Only when free disk is at least VACUUM_SPACE_FACTOR x (file + WAL);
 * otherwise nothing changes and the caller keeps running (deletion and
 * secure_delete still work, the file just cannot shrink). VACUUM's temp copy
 * goes to the database's own directory, never memory or /tmp: SQLite reads
 * SQLITE_TMPDIR once per process, so the (process-wide) temp_store_directory
 * pragma is set for the VACUUM only. Call it before workers or other
 * connections in this process start. Blocks while it runs.
 */
export function convertToIncremental(
  db: DatabaseSync,
  path: string,
  opts: { freeBytes?: (dir: string) => number; spaceFactor?: number } = {},
): VacuumConversion {
  if (autoVacuumMode(db) === AUTO_VACUUM_INCREMENTAL || path === ":memory:") return { status: "already" };
  return vacuumInPlace(db, path, { ...opts, incremental: true });
}

/**
 * Rebuild the whole file (VACUUM), so no deleted content survives anywhere in
 * it, including copies of cells that page splits left in the unused space of
 * live pages, which secure_delete never reaches. Same space rule, temp
 * directory and checkpoint as the conversion; `incremental` also switches the
 * file to incremental auto_vacuum. Blocks every writer while it runs: call it
 * at startup, before ingest listens.
 */
export function vacuumInPlace(
  db: DatabaseSync,
  path: string,
  opts: { freeBytes?: (dir: string) => number; spaceFactor?: number; incremental?: boolean } = {},
): Exclude<VacuumConversion, { status: "already" }> {
  const dir = dirname(resolve(path));
  const bytesBefore = fileBytes(path);
  const needBytes = Math.ceil((opts.spaceFactor ?? VACUUM_SPACE_FACTOR) * (bytesBefore + fileBytes(`${path}-wal`)));
  const freeBytes = (opts.freeBytes ?? freeBytesAt)(dir);
  if (freeBytes < needBytes) return { status: "no_space", needBytes, freeBytes };

  const started = performance.now();
  if (opts.incremental) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA temp_store = FILE");
  db.exec(`PRAGMA temp_store_directory = '${dir.replaceAll("'", "''")}'`);
  try {
    db.exec("VACUUM");
  } finally {
    db.exec("PRAGMA temp_store_directory = ''");
    db.exec("PRAGMA temp_store = DEFAULT");
  }
  checkpointTruncate(db);
  return { status: "converted", ms: Math.round(performance.now() - started), bytesBefore, bytesAfter: fileBytes(path) };
}

/**
 * Move WAL contents into the main file and truncate the WAL. `busy` is true
 * when a reader's snapshot stopped it from finishing: the old page images are
 * then still in the WAL, and the caller must try again. With `noWait` it does
 * not wait for readers (the connection's busy_timeout would block the thread
 * for seconds); the caller retries later instead.
 */
export function checkpointTruncate(db: DatabaseSync, opts: { noWait?: boolean } = {}): { busy: boolean } {
  if (!opts.noWait) {
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    return { busy: Number(row?.busy ?? 0) !== 0 };
  }
  const { timeout } = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  db.exec("PRAGMA busy_timeout = 0");
  try {
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    return { busy: Number(row?.busy ?? 0) !== 0 };
  } catch (err) {
    if ((err as { errcode?: number }).errcode === 5 || /SQLITE_BUSY|database is locked/i.test(String(err))) return { busy: true };
    throw err;
  } finally {
    db.exec(`PRAGMA busy_timeout = ${Number(timeout)}`);
  }
}

/** Return up to `pages` free pages to the filesystem. Returns the free pages left (0 when not incremental). */
export function incrementalVacuum(db: DatabaseSync, pages: number): number {
  if (autoVacuumMode(db) !== AUTO_VACUUM_INCREMENTAL) return 0;
  db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
  return freelistCount(db);
}
