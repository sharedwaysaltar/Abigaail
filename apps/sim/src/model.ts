// What the demo apps do with a request, for seeded history and the replay
// tests. demo-node's numbers live in apps/demo-node/faults.mjs; a test keeps
// these equal to them. demo-next's are measured approximations (its pages
// are cheap; /api/slow sleeps 300 ms; /api/boom always throws).

import { between, type Rng } from "./random.js";
import type { AppKind } from "./traffic.js";

export interface Faults {
  dependency: "ok" | "failing";
  slowSearch: boolean;
  userErrorShare: number;
  /** KB each /search request keeps for good. */
  leakPerRequest: number;
  /** KB kept for good every second, whatever the traffic. */
  leakPerSecond: number;
  /** /docs blocks the event loop for BLOCK_DOCS_MS. */
  blockDocs: boolean;
  /** With a leak, the process is killed (SIGKILL) when its heap passes this many MB; 0 = off. */
  oomKillMb: number;
  /** A bad release: share of /checkout requests that throw a TypeError (500). */
  checkoutBug: number;
  /** A slow release: extra ms on every /search. */
  searchExtraMs: number;
  /** A release that fails to start: an uncaught MigrationError this long after each start; 0 = off. */
  crashAfterMs: number;
}

export const NORMAL_FAULTS: Faults = { dependency: "ok", slowSearch: false, userErrorShare: 0, leakPerRequest: 0, leakPerSecond: 0, blockDocs: false, oomKillMb: 0, checkoutBug: 0, searchExtraMs: 0, crashAfterMs: 0 };

/** Mirrors NORMAL_MS, DEPENDENCY_MS and SLOW_SEARCH_MS in apps/demo-node/faults.mjs. */
export const NODE_MS: Record<string, readonly [number, number]> = {
  "/": [5, 15],
  "/docs": [10, 30],
  "/user/[id]": [8, 20],
  "/search": [40, 80],
  "/checkout": [10, 20],
};
export const DEPENDENCY_MS: readonly [number, number] = [15, 25];
export const SLOW_SEARCH_MS = 1200;
/**
 * Where demo-node's fault code lives, as its profiles name it (the SDK's root
 * is the repository, the simulator's working directory). A test keeps the
 * lines equal to apps/demo-node/faults.mjs.
 */
export const DEMO_FRAMES = {
  handler: { file: "apps/demo-node/server.mjs", line: 75 },
  renderDocs: { file: "apps/demo-node/faults.mjs", line: 113, fn: "renderDocs" },
  rememberSearch: { file: "apps/demo-node/faults.mjs", line: 96, fn: "rememberSearch" },
  applyDiscount: { file: "apps/demo-node/faults.mjs", line: 135, fn: "applyDiscount" },
  runMigrations: { file: "apps/demo-node/faults.mjs", line: 143, fn: "runMigrations" },
} as const;
export const BLOCK_DOCS_MS = 300;
/** The host demo-node's /checkout calls. */
export const DEPENDENCY_HOST = "localhost";

const NEXT_MS: Record<string, readonly [number, number]> = {
  "/": [5, 15],
  "/about": [5, 15],
  "/user/[id]": [10, 25],
  "/api/slow": [300, 310],
  "/api/boom": [1, 5],
};

export interface Outcome {
  route: string;
  status: number;
  duration: number;
  outbound?: { host: string; status: number; duration: number };
  /** Error class of an error event the request produces. */
  error?: string;
}

/** The route pattern the app's SDK reports for a path (404s on unknown paths are "unmatched"). */
export function routeOf(app: AppKind, path: string): string | undefined {
  const p = path.split("?")[0]!;
  if (/^\/user\/[^/]+$/.test(p)) return "/user/[id]";
  const known = app === "node" ? NODE_MS : NEXT_MS;
  return p in known ? p : undefined;
}

export function outcome(r: Rng, app: AppKind, path: string, faults: Faults): Outcome {
  const route = routeOf(app, path);
  if (!route) return { route: "unmatched", status: 404, duration: between(r, [0, 2]) };
  if (app === "next") {
    const duration = between(r, NEXT_MS[route]!);
    return route === "/api/boom" ? { route, status: 500, duration, error: "TypeError" } : { route, status: 200, duration };
  }
  const own = between(r, NODE_MS[route]!);
  switch (route) {
    case "/user/[id]":
      return r() < faults.userErrorShare ? { route, status: 500, duration: own, error: "RangeError" } : { route, status: 200, duration: own };
    case "/search":
      return { route, status: 200, duration: (faults.slowSearch ? SLOW_SEARCH_MS : own) + faults.searchExtraMs };
    case "/docs":
      return { route, status: 200, duration: faults.blockDocs ? BLOCK_DOCS_MS + own : own };
    case "/checkout": {
      // Drawn only while the fault is on, so every other run keeps its random sequence.
      if (faults.checkoutBug > 0 && r() < faults.checkoutBug) return { route, status: 500, duration: own, error: "TypeError" };
      const dep = faults.dependency === "ok" ? between(r, DEPENDENCY_MS) : between(r, [1, 3]);
      const status = faults.dependency === "ok" ? 200 : 503;
      return { route, status: status === 200 ? 200 : 502, duration: own + dep, outbound: { host: DEPENDENCY_HOST, status, duration: dep } };
    }
    default:
      return { route, status: 200, duration: own };
  }
}
