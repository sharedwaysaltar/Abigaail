import { LIMITS, ROUTE_OTHER, ROUTE_UNMATCHED } from "@abigaail/schema";

// Route normalisation keeps cardinality bounded and keeps identifiers out of
// stored data. Two layers:
// 1. Known patterns (from the framework's router, e.g. Next.js "/user/[id]").
// 2. A heuristic fallback that replaces ID-like segments with "[id]".
// A per-process cap then folds anything beyond N distinct routes into "other".

interface CompiledPattern {
  pattern: string;
  regex: RegExp;
  /** Static segments count; more static segments = more specific. */
  specificity: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile Next.js-style patterns: "[id]" (one segment), "[...slug]" (one or
 * more), "[[...slug]]" (zero or more). Route groups "(group)" are removed.
 */
export function compilePatterns(patterns: readonly string[]): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (const raw of patterns) {
    const pattern = raw
      .split("/")
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
      .join("/") || "/";
    let specificity = 0;
    let re = "";
    for (const seg of pattern.split("/").filter(Boolean)) {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) re += "(?:/[^/]+)*";
      else if (/^\[\.\.\.[^\]]+\]$/.test(seg)) re += "(?:/[^/]+)+";
      else if (/^\[[^\]]+\]$/.test(seg)) re += "/[^/]+";
      else {
        re += "/" + escapeRe(seg);
        specificity++;
      }
    }
    compiled.push({ pattern, regex: new RegExp(`^${re || "/"}/?$`), specificity });
  }
  // Prefer the most specific match: "/user/me" before "/user/[id]".
  return compiled.sort((a, b) => b.specificity - a.specificity);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const HEX_RE = /^[0-9a-f]{16,}$/i;
// Long tokens mixing letters and digits (base64/base62 ids, session tokens).
const TOKEN_RE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{20,}$/;

/** Whether a single path segment looks like an identifier rather than a word. */
export function isIdLike(segment: string): boolean {
  if (segment.length > 64) return true;
  return (
    NUMERIC_RE.test(segment) ||
    UUID_RE.test(segment) ||
    HEX_RE.test(segment) ||
    TOKEN_RE.test(segment) ||
    segment.includes("@") ||
    segment.includes("%") ||
    // Anything outside the characters a normalised route may contain.
    !/^[A-Za-z0-9._~-]+$/.test(segment)
  );
}

/** Strip query string and fragment, collapse slashes. Never keeps query values. */
export function pathOnly(url: string): string {
  let path = url;
  // Absolute URL: drop scheme and host.
  const schemeEnd = path.indexOf("://");
  if (schemeEnd !== -1) {
    const slash = path.indexOf("/", schemeEnd + 3);
    path = slash === -1 ? "/" : path.slice(slash);
  }
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  path = path.replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = "/" + path;
  return path;
}

/** Heuristic fallback: replace ID-like segments with "[id]". */
export function heuristicRoute(path: string): string {
  const segs = pathOnly(path).split("/").filter(Boolean);
  const out = segs.map((s) => (isIdLike(s) ? "[id]" : s));
  const route = "/" + out.join("/");
  return route.length > LIMITS.maxRouteLength ? ROUTE_OTHER : route;
}

export interface RouteNormaliserOptions {
  /** Known route patterns from the framework. */
  patterns?: readonly string[];
  /** Max distinct routes reported per process; the rest become "other". */
  maxRoutes?: number;
  /**
   * What to do with paths that match no known pattern. "heuristic" applies the
   * ID heuristic; "unmatched" reports the constant "unmatched" (safest when the
   * full route list is known, e.g. from a Next.js build manifest).
   */
  fallback?: "heuristic" | "unmatched";
}

export class RouteNormaliser {
  private readonly compiled: CompiledPattern[];
  private readonly seen = new Set<string>();
  private readonly maxRoutes: number;
  private readonly fallback: "heuristic" | "unmatched";

  constructor(opts: RouteNormaliserOptions = {}) {
    this.compiled = compilePatterns(opts.patterns ?? []);
    this.maxRoutes = opts.maxRoutes ?? 500;
    this.fallback = opts.fallback ?? "heuristic";
  }

  normalise(url: string): string {
    const path = pathOnly(url);
    let route: string | undefined;
    for (const c of this.compiled) {
      if (c.regex.test(path)) {
        route = c.pattern;
        break;
      }
    }
    route ??= this.fallback === "unmatched" ? ROUTE_UNMATCHED : heuristicRoute(path);
    return this.cap(route);
  }

  private cap(route: string): string {
    if (route === ROUTE_OTHER || route === ROUTE_UNMATCHED || this.seen.has(route)) return route;
    if (this.seen.size >= this.maxRoutes) return ROUTE_OTHER;
    this.seen.add(route);
    return route;
  }
}
