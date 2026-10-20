// Everything the simulator writes lives in data/sim/. Paths are checked with
// realpath (the nearest existing ancestor's realpath for a file not created
// yet), so a symlink cannot point the simulator at the real database.

import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is apps/sim/src or apps/sim/dist). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** realpath of `p`, or of its nearest existing ancestor joined with the rest. A dangling symlink is refused. */
export function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      let link = false;
      try {
        link = lstatSync(cur).isSymbolicLink();
      } catch {
        // Does not exist at all: look at the parent.
      }
      if (link) throw new Error(`refusing ${p}: it is a symlink to a path that does not exist`);
      const parent = dirname(cur);
      if (parent === cur) throw err;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** True when `p` resolves strictly inside `dir`. */
export function isInside(dir: string, p: string): boolean {
  const rel = relative(realish(dir), realish(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface SimPaths {
  dir: string;
  db: string;
  salt: string;
  authDb: string;
  log: string;
  report: string;
}

/**
 * The simulator's files under `<root>/data/sim/`, each checked. data/sim must
 * be a real directory (not a symlink) inside data/.
 */
export function simPaths(root = REPO_ROOT): SimPaths {
  const data = join(root, "data");
  const dir = join(data, "sim");
  assertSimDir(data, dir);
  const file = (name: string) => {
    const p = join(dir, name);
    if (!isInside(dir, p)) throw new Error(`refusing ${p}: it resolves outside data/sim/`);
    return p;
  };
  return {
    dir,
    db: file("abigaail.db"),
    salt: file("salt.bin"),
    authDb: file("auth.db"),
    log: file("sim.log"),
    report: file("report.json"),
  };
}

function assertSimDir(data: string, dir: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(dir).isSymbolicLink();
  } catch {
    // Not created yet.
  }
  if (isLink) throw new Error(`refusing ${dir}: data/sim must be a directory, not a symlink`);
  if (!isInside(data, dir)) throw new Error(`refusing ${dir}: it resolves outside data/`);
}

/** Create data/sim/ (checked). */
export function ensureSimDir(root = REPO_ROOT): SimPaths {
  const paths = simPaths(root);
  mkdirSync(paths.dir, { recursive: true });
  return simPaths(root);
}

/** `npm run sim -- reset`: delete data/sim/ and nothing else. */
export function resetSim(root = REPO_ROOT): string {
  const { dir } = simPaths(root);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
