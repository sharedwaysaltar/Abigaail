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
}

export const NORMAL_FAULTS: Faults = { dependency: "ok", slowSearch: false, userErrorShare: 0 };

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
      return { route, status: 200, duration: faults.slowSearch ? SLOW_SEARCH_MS : own };
    case "/checkout": {
      const dep = faults.dependency === "ok" ? between(r, DEPENDENCY_MS) : between(r, [1, 3]);
      const status = faults.dependency === "ok" ? 200 : 503;
      return { route, status: status === 200 ? 200 : 502, duration: own + dep, outbound: { host: DEPENDENCY_HOST, status, duration: dep } };
    }
    default:
      return { route, status: 200, duration: own };
  }
}
