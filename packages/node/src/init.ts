import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import dc from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  cleanRegion,
  createClient,
  pathOnly,
  RouteNormaliser,
  type AbigaailClient,
  type ClientOptions,
  type ClientStats,
} from "@abigaail/core";
import {
  ENVIRONMENTS,
  HTTP_METHODS,
  ROUTE_UNMATCHED,
  type Environment,
  type HttpMethod,
  type MetricName,
  type OutboundOutcome,
} from "@abigaail/schema";
import { requestFlags } from "./flags.js";
import { clientIp, isLocalAddress } from "./proxy.js";
import { errorCodeOf, errorDetail, errorType, parseStack } from "./stack.js";

export const DEFAULT_IGNORE: readonly string[] = ["/_next/static/*", "/_next/image", "/favicon.ico", "/robots.txt"];

export interface NodeOptions extends Partial<Omit<ClientOptions, "environment">> {
  environment?: Environment;
  /** Known route patterns, e.g. from the framework's router ("/user/[id]"). */
  routes?: readonly string[];
  /** For paths matching no known pattern. Default "heuristic". */
  routeFallback?: "heuristic" | "unmatched";
  /** Max distinct routes per process; the rest become "other". Default 500. */
  maxRoutes?: number;
  /** Paths never captured. A trailing "*" matches any suffix. Default DEFAULT_IGNORE. */
  ignore?: readonly string[];
  /**
   * Number of reverse proxies in front of the app. 0 (default) uses the socket
   * address. Behind Caddy or nginx on the same machine, set 1.
   */
  trustProxy?: number;
  /** Project root; stack frames outside it are dropped. Default process.cwd(). */
  root?: string;
  /** Metric sampling interval. Default 30000 ms; 0 disables. */
  metricsIntervalMs?: number;
  /** Heartbeat interval. Default 60000 ms; 0 disables. */
  heartbeatIntervalMs?: number;
  /** Environment to read configuration from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Link outbound calls and errors to the inbound request that caused them
   * (`parent_id`), via AsyncLocalStorage. Default: true on Node >= 24, false
   * on older Node, where it costs more (DECISIONS #38).
   */
  linkOutbound?: boolean;
  /** Node version used to pick defaults. For tests; default process.versions.node. */
  nodeVersion?: string;
  /** Hosting region code sent with the boot event, e.g. "LON1". Default ABIGAAIL_REGION. */
  region?: string;
}

/** Linking is on by default only where AsyncLocalStorage is cheap (Node >= 24). */
export function defaultLinkOutbound(nodeVersion: string): boolean {
  const major = Number.parseInt(nodeVersion.replace(/^v/, ""), 10);
  return Number.isFinite(major) && major >= 24;
}

export interface ErrorContext {
  /** Normalised route pattern, if known. */
  route?: string;
  /** Default true: the app caught it. */
  handled?: boolean;
}

export interface AbigaailNode {
  captureError(err: unknown, ctx?: ErrorContext): void;
  /** Report a framework-resolved route pattern through the route normaliser. */
  routePattern(raw: string): string;
  flush(): Promise<void>;
  /** Sends a shutdown event, stops listening and makes one bounded final flush. */
  shutdown(timeoutMs?: number): Promise<void>;
  stats(): ClientStats;
}

const SINGLETON = Symbol.for("abigaail.node");
/** Sampling interval of the event-loop delay histogram; every reading includes it. */
const LOOP_RESOLUTION_MS = 20;
type Global = typeof globalThis & { [SINGLETON]?: AbigaailNode };

const NOOP: AbigaailNode = {
  captureError() {},
  routePattern: () => "other",
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  stats: () => ({ queued: 0, dropped: 0, invalid: 0, sampledOut: 0, sent: 0, rejected: 0, failedSends: 0, breaker: "closed" }),
};

/** The running instance, if init() succeeded; for framework hooks that must not start one. */
export function current(): AbigaailNode | undefined {
  return (globalThis as Global)[SINGLETON];
}

/** Problems the SDK reports about its own configuration. Messages never contain values. */
export class AbigaailWarning extends Error {
  override name = "AbigaailWarning";
}

function defaultReporter(): (err: unknown) => void {
  const seen = new Set<string>();
  return (err) => {
    // Only our own messages are printed; other internal errors could carry data.
    const msg = err instanceof AbigaailWarning ? err.message : `internal error (${errorType(err)})`;
    if (seen.has(msg) || seen.size > 50) return;
    seen.add(msg);
    console.warn(`[abigaail] ${msg}`);
  };
}

function environmentFrom(env: NodeJS.ProcessEnv): Environment {
  const v = env.ABIGAAIL_ENVIRONMENT ?? (env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development");
  return (ENVIRONMENTS as readonly string[]).includes(v) ? (v as Environment) : "development";
}

const toMethod = (m: unknown): HttpMethod => {
  const up = typeof m === "string" ? m.toUpperCase() : "";
  return (HTTP_METHODS as readonly string[]).includes(up) ? (up as HttpMethod) : "OTHER";
};

const toBytes = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

function compileIgnore(patterns: readonly string[]): (path: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    if (p.endsWith("*")) prefixes.push(p.slice(0, -1));
    else exact.add(p);
  }
  return (path) => exact.has(path) || prefixes.some((p) => path.startsWith(p));
}

function referrerDomain(header: unknown): string | undefined {
  if (typeof header !== "string" || header.length > 2048) return undefined;
  try {
    return new URL(header).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Host of a URL, with port, or undefined. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether visitor IP and user agent may be sent to `endpoint`: only over https,
 * or over plain http to this machine (127.0.0.0/8, ::1, localhost).
 */
export function transientAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol === "https:") return true;
    if (u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

function timeoutLike(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | undefined;
  const s = `${String(e?.name ?? "")} ${String(e?.code ?? "")}`;
  return s.includes("Timeout") || s.includes("TIMEOUT") || s.includes("ETIMEDOUT") || s.includes("AbortError");
}

/**
 * Start capturing. Reads ABIGAAIL_ENDPOINT, ABIGAAIL_INGEST_KEY, ABIGAAIL_RELEASE,
 * ABIGAAIL_ENVIRONMENT and ABIGAAIL_REGION unless given. Never throws: on any problem it returns
 * a no-op. Calling it again returns the running instance.
 */
export function init(opts: NodeOptions = {}): AbigaailNode {
  const g = globalThis as Global;
  const report = (() => {
    const hook = opts.onInternalError ?? defaultReporter();
    return (err: unknown) => {
      try {
        hook(err);
      } catch {
        // A broken error hook must not break the app.
      }
    };
  })();
  try {
    if (g[SINGLETON]) return g[SINGLETON];
    const env = opts.env ?? process.env;

    // Next inlines NEXT_PUBLIC_* into browser bundles: an ingest key there is public.
    const leaked = Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_ABIGAAIL"));
    if (leaked.length) {
      report(
        new AbigaailWarning(
          `refusing to start: ${leaked.join(", ")} would be inlined into browser code. Remove the NEXT_PUBLIC_ prefix.`,
        ),
      );
      return NOOP;
    }

    const endpoint = opts.endpoint ?? env.ABIGAAIL_ENDPOINT ?? "";
    const ingestKey = opts.ingestKey ?? env.ABIGAAIL_INGEST_KEY ?? "";
    if (opts.enabled === false) return NOOP;
    if (!endpoint || !ingestKey) {
      report(new AbigaailWarning("ABIGAAIL_ENDPOINT or ABIGAAIL_INGEST_KEY is not set; monitoring is off"));
      return NOOP;
    }
    let release = opts.release ?? env.ABIGAAIL_RELEASE;
    if (!release) {
      report(new AbigaailWarning("ABIGAAIL_RELEASE is not set; reporting release \"unknown\""));
      release = "unknown";
    }

    const client = createClient({
      ...opts,
      endpoint,
      ingestKey,
      release,
      environment: opts.environment ?? environmentFrom(env),
      onInternalError: report,
    });
    const sendTransient = transientAllowed(endpoint);
    if (!sendTransient) {
      report(
        new AbigaailWarning(
          "ABIGAAIL_ENDPOINT is plain http to another machine; visitor IP/UA are withheld until the endpoint uses https",
        ),
      );
    }
    let linkOutbound = opts.linkOutbound;
    if (linkOutbound === undefined) {
      linkOutbound = defaultLinkOutbound(opts.nodeVersion ?? process.versions.node);
      if (!linkOutbound) {
        report(
          new AbigaailWarning(
            "linking outbound calls to requests is off on this Node version for performance; set linkOutbound: true to enable it",
          ),
        );
      }
    }
    const rawRegion = opts.region ?? env.ABIGAAIL_REGION;
    const region = cleanRegion(rawRegion);
    if (rawRegion && !region) {
      report(new AbigaailWarning("ABIGAAIL_REGION is not a region code (letters, digits and hyphens, 2-24); sending no region"));
    }
    const instance = new NodeAdapter(client, { ...opts, linkOutbound, region }, report, hostOf(endpoint), sendTransient);
    g[SINGLETON] = instance;
    return instance;
  } catch (err) {
    report(err);
    return NOOP;
  }
}

class NodeAdapter implements AbigaailNode {
  private readonly routes: RouteNormaliser;
  private readonly ignored: (path: string) => boolean;
  private readonly trustProxy: number;
  private readonly root: string;
  /** Start times of in-flight inbound responses and outbound requests. */
  private readonly starts = new WeakMap<object, number>();
  private readonly outMeta = new WeakMap<object, { host: string; method: HttpMethod; parent: string | undefined }>();
  /** event_id of each in-flight inbound request, chosen at start so calls it makes can name it. */
  private readonly requestIds = new WeakMap<object, string>();
  /** The current inbound request's event_id; undefined when linking is off. */
  private readonly current: AsyncLocalStorage<string> | undefined;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  private cpuPrev = process.cpuUsage();
  private wallPrev = performance.now();
  private warnedProxy = false;
  private stopped = false;

  constructor(
    private readonly client: AbigaailClient,
    opts: NodeOptions,
    private readonly report: (err: unknown) => void,
    private readonly ownHost: string | undefined,
    /** False when the endpoint is plain http off this machine (DECISIONS #36). */
    private readonly sendTransient: boolean,
  ) {
    this.routes = new RouteNormaliser({
      ...(opts.routes ? { patterns: opts.routes } : {}),
      ...(opts.routeFallback ? { fallback: opts.routeFallback } : {}),
      ...(opts.maxRoutes ? { maxRoutes: opts.maxRoutes } : {}),
    });
    this.ignored = compileIgnore(opts.ignore ?? DEFAULT_IGNORE);
    this.trustProxy = Number.isInteger(opts.trustProxy) && opts.trustProxy! > 0 ? opts.trustProxy! : 0;
    this.root = opts.root ?? process.cwd();
    this.current = opts.linkOutbound === false ? undefined : new AsyncLocalStorage<string>();

    this.listen("http.server.request.start", (m) => this.onServerStart(m));
    this.listen("http.server.response.finish", (m) => this.onServerFinish(m));
    this.listen("http.client.request.start", (m) => this.onClientStart(m));
    this.listen("http.client.response.finish", (m) => this.onClientFinish(m));
    this.listen("http.client.request.error", (m) => this.onClientError(m));
    this.listen("undici:request:create", (m) => this.onFetchCreate(m));
    this.listen("undici:request:headers", (m) => this.onFetchHeaders(m));
    this.listen("undici:request:error", (m) => this.onFetchError(m));

    // Observes fatal errors without changing what Node does with them. The
    // process usually exits before a flush; the next boot reveals the crash.
    const onFatal = (err: unknown) => this.captureError(err, { handled: false });
    process.on("uncaughtExceptionMonitor", onFatal);
    this.unsubscribers.push(() => process.off("uncaughtExceptionMonitor", onFatal));

    const metricsMs = opts.metricsIntervalMs ?? 30_000;
    if (metricsMs > 0) {
      this.loopDelay.enable();
      this.every(metricsMs, () => this.sampleMetrics());
    }
    const heartbeatMs = opts.heartbeatIntervalMs ?? 60_000;
    if (heartbeatMs > 0) this.every(heartbeatMs, () => this.client.capture({ type: "lifecycle", kind: "heartbeat" }));
    this.client.capture({ type: "lifecycle", kind: "boot", ...(opts.region ? { region: opts.region } : {}) });
  }

  /** Subscribe with every handler guarded: a subscriber that throws would surface in the host app. */
  private listen(channel: string, fn: (message: any) => void): void {
    const handler = (message: unknown) => {
      try {
        if (!this.stopped) fn(message);
      } catch (err) {
        this.report(err);
      }
    };
    dc.subscribe(channel, handler);
    this.unsubscribers.push(() => dc.unsubscribe(channel, handler));
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(() => {
      try {
        fn();
      } catch (err) {
        this.report(err);
      }
    }, ms);
    // Never keep the host process alive for telemetry.
    t.unref();
    this.timers.push(t);
  }

  // Inbound ---------------------------------------------------------------

  private onServerStart({ response }: { response: ServerResponse }): void {
    this.starts.set(response, performance.now());
    if (!this.current) return;
    const id = randomUUID();
    this.requestIds.set(response, id);
    // Published synchronously just before the server emits 'request', so the
    // handler and everything it awaits run with this id as their store.
    this.current.enterWith(id);
  }

  private onServerFinish({ request, response }: { request: IncomingMessage; response: ServerResponse }): void {
    const start = this.starts.get(response);
    if (start === undefined) return;
    this.starts.delete(response);
    const id = this.requestIds.get(response);
    this.requestIds.delete(response);
    const url = typeof request.url === "string" ? request.url : "/";
    const path = pathOnly(url);
    if (this.ignored(path)) return;

    const status = response.statusCode;
    // A 404 on no known pattern is a probe or a typo, not a route: keeps scanners
    // from filling the route cap. A 404 on a known pattern keeps its pattern.
    const route = status === 404 && !this.routes.match(path) ? ROUTE_UNMATCHED : this.routes.normalise(path);

    const ip = clientIp(request, this.trustProxy);
    if (this.trustProxy === 0 && !this.warnedProxy && ip && isLocalAddress(ip)) {
      this.warnedProxy = true;
      this.report(
        new AbigaailWarning(
          "requests arrive from a loopback or private address. Behind Caddy or nginx set trustProxy: 1, otherwise every visitor looks the same.",
        ),
      );
    }
    const ua = request.headers["user-agent"];
    const flags = requestFlags(url, status);
    const referrer = referrerDomain(request.headers.referer);
    const reqBytes = toBytes(request.headers["content-length"]);
    const resBytes = toBytes(response.getHeader("content-length"));

    this.client.capture({
      type: "request",
      ...(id ? { event_id: id } : {}),
      method: toMethod(request.method),
      route,
      status,
      duration_ms: Math.round((performance.now() - start) * 100) / 100,
      ...(reqBytes !== undefined ? { req_bytes: reqBytes } : {}),
      ...(resBytes !== undefined ? { res_bytes: resBytes } : {}),
      ...(referrer ? { referrer_domain: referrer } : {}),
      ...(flags ? { flags } : {}),
      ...(this.sendTransient
        ? { transient: { ...(ip ? { ip } : {}), ...(typeof ua === "string" ? { ua } : {}) } }
        : {}),
    });
  }

  // Outbound --------------------------------------------------------------

  private outbound(key: object, status: number | undefined, outcome: OutboundOutcome, errorCode?: string): void {
    const rec = this.starts.get(key);
    if (rec === undefined) return;
    this.starts.delete(key);
    const meta = this.outMeta.get(key);
    this.outMeta.delete(key);
    if (!meta) return;
    this.client.capture({
      type: "outbound",
      host: meta.host,
      method: meta.method,
      ...(status !== undefined ? { status } : {}),
      duration_ms: Math.round((performance.now() - rec) * 100) / 100,
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(meta.parent ? { parent_id: meta.parent } : {}),
    });
  }

  private startOutbound(key: object, hostWithPort: string | undefined, hostname: string | undefined, method: unknown): void {
    // Our own sends to ingest are not app traffic, and reporting them would loop.
    if (!hostname || (hostWithPort && hostWithPort === this.ownHost)) return;
    this.starts.set(key, performance.now());
    this.outMeta.set(key, { host: hostname, method: toMethod(method), parent: this.current?.getStore() });
  }

  private onClientStart({ request }: { request: ClientRequest }): void {
    const hostHeader = request.getHeader("host");
    const withPort = typeof hostHeader === "string" ? hostHeader.toLowerCase() : undefined;
    this.startOutbound(request, withPort, request.host, request.method);
  }

  private onClientFinish({ request, response }: { request: ClientRequest; response: IncomingMessage }): void {
    this.outbound(request, response.statusCode, "ok");
  }

  private onClientError({ request, error }: { request: ClientRequest; error: unknown }): void {
    this.outbound(request, undefined, timeoutLike(error) ? "timeout" : "error", errorCodeOf(error));
  }

  private onFetchCreate({ request }: { request: { origin?: unknown; method?: unknown } }): void {
    const origin = typeof request.origin === "string" ? request.origin : String(request.origin ?? "");
    let hostname: string | undefined;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return;
    }
    this.startOutbound(request, hostOf(origin), hostname, request.method);
  }

  private onFetchHeaders({ request, response }: { request: object; response: { statusCode?: number } }): void {
    this.outbound(request, response.statusCode, "ok");
  }

  private onFetchError({ request, error }: { request: object; error: unknown }): void {
    this.outbound(request, undefined, timeoutLike(error) ? "timeout" : "error", errorCodeOf(error));
  }

  // Errors, metrics, lifecycle ---------------------------------------------

  captureError(err: unknown, ctx: ErrorContext = {}): void {
    try {
      if (this.stopped) return;
      const frames = parseStack(err, this.root);
      const parent = this.current?.getStore();
      this.client.capture({
        type: "error",
        error_type: errorType(err),
        // Raw here; the core sanitiser scrubs it before anything is queued.
        ...(errorDetail(err) as Record<string, string>),
        handled: ctx.handled ?? true,
        ...(ctx.route ? { route: ctx.route } : {}),
        ...(frames ? { frames } : {}),
        ...(parent ? { parent_id: parent } : {}),
      });
    } catch (e) {
      this.report(e);
    }
  }

  routePattern(raw: string): string {
    try {
      return this.routes.pattern(raw);
    } catch (err) {
      this.report(err);
      return "other";
    }
  }

  private sampleMetrics(): void {
    const mem = process.memoryUsage();
    const wallNow = performance.now();
    const cpu = process.cpuUsage(this.cpuPrev);
    const wallMs = wallNow - this.wallPrev;
    this.cpuPrev = process.cpuUsage();
    this.wallPrev = wallNow;
    const stats = this.client.stats();
    const round = (n: number) => Math.round(n * 100) / 100;
    const metric = (name: MetricName, value: number) =>
      this.client.capture({ type: "metric", name, value: round(value) });
    metric("memory_rss_mb", mem.rss / 1048576);
    metric("memory_heap_used_mb", mem.heapUsed / 1048576);
    // Process CPU time over wall time: can exceed 100 with several cores busy.
    if (wallMs > 0) metric("cpu_percent", ((cpu.user + cpu.system) / 1000 / wallMs) * 100);
    if (this.loopDelay.count > 0) {
      // Readings are timer intervals, so the resolution itself is not lag.
      const lag = (p: number) => Math.max(0, this.loopDelay.percentile(p) / 1e6 - LOOP_RESOLUTION_MS);
      metric("event_loop_lag_p50_ms", lag(50));
      metric("event_loop_lag_p99_ms", lag(99));
    }
    this.loopDelay.reset();
    metric("sdk_queue_size", stats.queued);
    metric("sdk_dropped_events", stats.dropped + stats.invalid);
  }

  flush(): Promise<void> {
    return this.client.flush();
  }

  async shutdown(timeoutMs = 1000): Promise<void> {
    try {
      if (this.stopped) return;
      this.client.capture({ type: "lifecycle", kind: "shutdown" });
      this.stopped = true;
      for (const t of this.timers) clearInterval(t);
      for (const u of this.unsubscribers) u();
      this.loopDelay.disable();
      this.current?.disable();
      const g = globalThis as Global;
      if (g[SINGLETON] === this) delete g[SINGLETON];
      await this.client.shutdown(timeoutMs);
    } catch (err) {
      this.report(err);
    }
  }

  stats(): ClientStats {
    return this.client.stats();
  }
}
