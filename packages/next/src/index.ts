// Next.js adapter, written against Next 16 (see DECISIONS). Use it from
// instrumentation.ts, importing it only when NEXT_RUNTIME === "nodejs":
//
//   export async function register() {
//     if (process.env.NEXT_RUNTIME === "nodejs") await (await import("@abigaail/next")).register();
//   }
//   export async function onRequestError(...args) {
//     if (process.env.NEXT_RUNTIME === "nodejs") (await import("@abigaail/next")).onRequestError(...args);
//   }

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { current, DEFAULT_IGNORE, init, type NodeOptions } from "@abigaail/node";

export interface NextOptions extends NodeOptions {
  /** Build output directory, relative to the project root. Default ".next". */
  distDir?: string;
}

/** Framework routes that exist in every Next app but not in the manifest. */
const NEXT_BUILTIN_ROUTES = ["/_next/static/[...path]", "/_next/data/[...path]", "/_next/image"];

export interface NextRoutes {
  /** Route patterns ("/user/[id]"), without basePath. */
  routes: string[];
  basePath: string;
}

/**
 * Route patterns from the build's routes-manifest.json (the `page` of each
 * static and dynamic route). Undefined when there is no usable manifest, e.g.
 * under `next dev` before a build.
 */
export function loadNextRoutes(distDir: string): NextRoutes | undefined {
  try {
    const text = readFileSync(join(distDir, "routes-manifest.json"), "utf8");
    const m = JSON.parse(text) as { basePath?: unknown; staticRoutes?: unknown; dynamicRoutes?: unknown };
    const pages = new Set<string>();
    for (const list of [m.staticRoutes, m.dynamicRoutes]) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const page = (r as { page?: unknown } | null)?.page;
        if (typeof page === "string" && page.startsWith("/")) pages.add(page);
      }
    }
    if (!pages.size) return undefined;
    const basePath = typeof m.basePath === "string" && /^(\/[A-Za-z0-9._~-]+)*$/.test(m.basePath) ? m.basePath : "";
    return { routes: [...pages], basePath };
  } catch {
    return undefined;
  }
}

/**
 * Next's onRequestError `routePath` is the route file path ("/app/blog/[slug]/page",
 * "/pages/api/x"). Turn it into the URL pattern: drop the router directory and the
 * file-convention suffix. Groups and slots are removed later by the normaliser.
 */
export function routeFromRoutePath(routePath: string): string {
  let r = routePath.replace(/^\/(src\/)?(app|pages)(?=\/|$)/, "");
  r = r.replace(/\/(page|route|layout|default|error|not-found|loading|template)$/, "");
  r = r.replace(/\/index$/, "");
  return r || "/";
}

/** Start monitoring. Only acts in the Node.js runtime; never throws. */
export async function register(opts: NextOptions = {}): Promise<void> {
  try {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const manifest = loadNextRoutes(join(opts.root ?? process.cwd(), opts.distDir ?? ".next"));
    const base = manifest?.basePath ?? "";
    const prefix = (patterns: readonly string[]) => patterns.map((p) => (base && p === "/" ? base : base + p));
    init({
      ...opts,
      routes: [...prefix(NEXT_BUILTIN_ROUTES), ...prefix(manifest?.routes ?? []), ...(opts.routes ?? [])],
      // With the full route list, anything else is reported as "unmatched", the safest choice.
      routeFallback: opts.routeFallback ?? (manifest ? "unmatched" : "heuristic"),
      ignore: opts.ignore ?? prefix(DEFAULT_IGNORE),
    });
  } catch (err) {
    try {
      opts.onInternalError?.(err);
    } catch {
      // Never let monitoring break startup.
    }
  }
}

/** The parts of Next's onRequestError context this adapter reads. */
export interface RequestErrorContext {
  routePath?: string;
  [key: string]: unknown;
}

/**
 * Next's onRequestError hook. Records the error class and frames against the
 * route pattern. The request object (path, headers) is never read.
 */
export function onRequestError(err: unknown, _request: unknown, context: RequestErrorContext): void {
  try {
    const sdk = current();
    if (!sdk) return;
    const raw = typeof context?.routePath === "string" ? routeFromRoutePath(context.routePath) : undefined;
    sdk.captureError(err, { handled: false, ...(raw ? { route: sdk.routePattern(raw) } : {}) });
  } catch {
    // Fail open: an error in the error hook must not change the response.
  }
}
