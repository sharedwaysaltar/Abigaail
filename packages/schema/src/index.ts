// Abigaail event schema, version 1.
//
// This file is types and constants only: no runtime dependencies, so the SDK can
// import it without pulling a validator into monitored apps. Server-side
// validation lives in ./validate.ts.
//
// Rules this schema encodes (see docs/ROADMAP.md and the project spec):
// - Only named fields exist. Anything not declared here is rejected by the server.
// - No bodies, headers, cookies, query values, emails, names or user IDs. The only
//   free text is an error's message, and only after the shared scrubber (./scrub.ts).
// - `transient` fields (client IP, user agent) are used in memory at ingest for
//   geo, bot class and the rotating visitor hash, then discarded. Never stored.
// - The server sets the authoritative timestamp; `client_ts` is advisory only.
// - Each event has an idempotent `event_id`, so retries cannot double count.

export const SCHEMA_VERSION = 1 as const;

/** Versions the server accepts: current (N) and previous (N-1). */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

export const LIMITS = {
  maxEventsPerBatch: 500,
  maxBatchBytes: 512 * 1024,
  maxRouteLength: 200,
  maxReleaseLength: 64,
  maxHostLength: 253,
  maxStackFrames: 20,
  maxFramePathLength: 200,
  maxErrorTypeLength: 100,
  /** Scrubbed error messages (SCRUB_LIMITS.outputMax). */
  maxMessageLength: 200,
  maxCodeLength: 40,
} as const;

/** Route placeholders used when a real pattern is unknown or a cap is hit. */
export const ROUTE_OTHER = "other";
export const ROUTE_UNMATCHED = "unmatched";

export const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
  "OTHER",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const ENVIRONMENTS = ["production", "staging", "development", "test"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Signals detected inside the app. Only the signal name leaves the app, never the raw input. */
export const REQUEST_FLAGS = [
  "scanner_path",
  "injection_like",
  "auth_failure",
  "rate_limited",
] as const;
export type RequestFlag = (typeof REQUEST_FLAGS)[number];

/**
 * Optional parts of schema v1 that a server announces in its 202 answer
 * (`{features: [...]}`). An SDK sends what a feature covers only after the
 * server it talks to has announced it, so a newer SDK never loses batches to an
 * older server (DECISIONS #110).
 */
export const FEATURES = ["runtime_v1"] as const;
export type Feature = (typeof FEATURES)[number];
export const FEATURE_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_FEATURES = 16;

/** Metrics covered by `runtime_v1`: post-GC heap floor, GC work, off-heap memory, event-loop blocks. */
export const RUNTIME_METRIC_NAMES = [
  "heap_floor_mb",
  "event_loop_blocks",
  "gc_major_count",
  "gc_pause_ms",
  "memory_external_mb",
  "memory_array_buffers_mb",
] as const;

export const METRIC_NAMES = [
  "memory_rss_mb",
  "memory_heap_used_mb",
  "cpu_percent",
  "event_loop_lag_p50_ms",
  "event_loop_lag_p99_ms",
  "sdk_queue_size",
  "sdk_dropped_events",
  ...RUNTIME_METRIC_NAMES,
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

/** `ready` (runtime_v1): the process is listening; carries startup cost and the previous exit. */
export const LIFECYCLE_KINDS = ["boot", "heartbeat", "shutdown", "ready"] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export const OUTBOUND_OUTCOMES = ["ok", "error", "timeout"] as const;
export type OutboundOutcome = (typeof OUTBOUND_OUTCOMES)[number];

/** Used at ingest only, then discarded. Never persisted, never echoed back. */
export interface Transient {
  ip?: string;
  ua?: string;
}

interface BaseEvent {
  event_id: string;
  /** Client clock in epoch ms. Advisory only: the server timestamp is authoritative. */
  client_ts: number;
}

export interface RequestEvent extends BaseEvent {
  type: "request";
  method: HttpMethod;
  /** Normalised route pattern, e.g. "/user/[id]". Never a raw URL. */
  route: string;
  status: number;
  duration_ms: number;
  req_bytes?: number;
  res_bytes?: number;
  /** Fraction of request events kept by the SDK sampler (1 = all). Agents weight counts by 1/sample_rate. */
  sample_rate?: number;
  /** Referrer domain only (e.g. "example.com"), never the full URL. */
  referrer_domain?: string;
  flags?: RequestFlag[];
  transient?: Transient;
}

export interface StackFrame {
  /** Project-relative path, e.g. "src/app/api/chat/route.ts". */
  file: string;
  line: number;
  col?: number;
  fn?: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  /** Error class name, e.g. "TypeError". */
  error_type: string;
  route?: string;
  handled: boolean;
  frames?: StackFrame[];
  /** The message after the shared scrubber (scrub.ts), never as thrown. */
  message?: string;
  /** An error code by pattern only (cleanCode): ECONNREFUSED, P2002, 23505, ERR_INVALID_ARG_TYPE ... */
  code?: string;
  /** The cause's class name, code and scrubbed message (one level). */
  cause_type?: string;
  cause_code?: string;
  cause_message?: string;
  /** SCRUB_VERSION of the scrubber that produced message / cause_message. */
  scrub_version?: number;
  /** `event_id` of the inbound request this error happened in, if known. */
  parent_id?: string;
}

export interface OutboundEvent extends BaseEvent {
  type: "outbound";
  /** Hostname only, never path or query. */
  host: string;
  method: HttpMethod;
  status?: number;
  duration_ms: number;
  outcome: OutboundOutcome;
  /** For a failed call: the error's code by pattern only (ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT ...). */
  error_code?: string;
  /**
   * `event_id` of the inbound request that made this call, if known. Not a new
   * identifier: it repeats an id the request event already carries.
   */
  parent_id?: string;
}

export interface MetricEvent extends BaseEvent {
  type: "metric";
  name: MetricName;
  value: number;
}

/** How the previous process of this instance ended, from the SDK's opt-in crash record. */
export interface PrevExit {
  /** Exit code Node reported (0-255). A kill by signal or out of memory leaves no record at all. */
  code: number;
  /** Class name of the uncaught error that ended it, if one did. */
  error_type?: string;
  /** Its first project-relative frame. */
  frame?: StackFrame;
  /** Heap in use at exit, MB. */
  heap_mb?: number;
  /** How long that process ran, seconds. */
  uptime_s?: number;
}

export interface LifecycleEvent extends BaseEvent {
  type: "lifecycle";
  kind: LifecycleKind;
  /**
   * Where the app runs, as a hosting region code (e.g. "LON1"). Boot events
   * only; the dashboard places the app on its map from it.
   */
  region?: string;
  /**
   * Opaque instance id (12 hex): a keyed hash of host name, process-manager
   * instance and cluster worker, never the names themselves. On ready,
   * heartbeat and shutdown (runtime_v1), so restarts are paired per instance.
   */
  instance?: string;
  /** ready only: the `event_id` of this process's boot event (not a new identifier). */
  boot_id?: string;
  /** ready only: ms from process start until the first server was listening. */
  startup_ms?: number;
  /** ready only: V8's heap limit, MB. */
  heap_limit_mb?: number;
  /** ready only: the container's memory limit, MB, when one is set. */
  memory_limit_mb?: number;
  /** ready only: how the previous process of this instance ended (crash record, opt-in). */
  prev_exit?: PrevExit;
}

/**
 * Event-loop blocks in one metrics interval charged to a route (runtime_v1).
 * No route: nothing was in flight (timers, startup or background work).
 */
export interface BlockEvent extends BaseEvent {
  type: "block";
  route?: string;
  /** Blocks this route was charged for. */
  count: number;
  /** Blocked time charged to it (a block shared by several suspects is split). */
  total_ms: number;
  /** Longest block it was charged for. */
  max_ms: number;
}

export type AbigaailEvent = RequestEvent | ErrorEvent | OutboundEvent | MetricEvent | LifecycleEvent | BlockEvent;
export type EventType = AbigaailEvent["type"];

/** Event as handed to the SDK: the SDK fills in event_id and client_ts. */
export type EventInput = AbigaailEvent extends infer E
  ? E extends AbigaailEvent
    ? Omit<E, "event_id" | "client_ts"> & Partial<Pick<E, "event_id" | "client_ts">>
    : never
  : never;

/** What the SDK POSTs to /ingest. */
export interface Batch {
  schema_version: number;
  sdk: { name: string; version: string };
  /** Deploy version of the sending app, e.g. a git SHA. */
  release: string;
  environment: Environment;
  /**
   * Client clock (epoch ms) when this send attempt was made; refreshed on retry.
   * The server only uses `sent_at - client_ts` (a duration on one clock), so a
   * skewed client clock does not skew event times.
   */
  sent_at?: number;
  events: AbigaailEvent[];
}

// ---------------------------------------------------------------------------
// Shared value patterns. The server validator and the SDK sanitiser both use
// these, so an event the SDK queues is one the server accepts.

/** A normalised route: path characters plus [param] placeholders. No query, fragment, %, space or "@". */
export const ROUTE_RE = /^\/[A-Za-z0-9._~\-[\]/]*$/;
/** Hostnames only: letters, digits, dots and hyphens (IDNs arrive as punycode). */
export const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
/** Identifiers: error class names and function names. */
export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;
/** Release strings: git SHAs, semver, build ids. No spaces or free text. */
export const RELEASE_RE = /^[A-Za-z0-9._\-+]+$/;
/** Project-relative frame paths. Absolute paths would leak usernames and hostnames. */
export const FRAME_PATH_RE = /^(?![/\\])(?![A-Za-z]:)[A-Za-z0-9._\-/@[\]()]+$/;
export const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
export const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;

/** Opaque instance ids (see LifecycleEvent.instance). */
export const INSTANCE_RE = /^[0-9a-f]{12}$/;
/** Exit codes Node reports. */
export const MAX_EXIT_CODE = 255;
/** Upper bound for memory sizes in MB (1 PB); anything above is not a reading. */
export const MAX_MEMORY_MB = 1e9;

/** Hosting region codes (e.g. "LON1", "US-EAST-1"): uppercase letters, digits and hyphens. */
export const REGION_RE = /^[A-Z0-9-]{2,24}$/;

/** RFC 9562 UUID (any version 1-8), the form of `event_id`. */
export const EVENT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
/** Longest duration an event may report (24 h). */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Outbound host placeholders: an IP literal is never stored as a host. */
export const HOST_IP_LITERAL = "ip-literal";
export const HOST_INVALID = "invalid-host";
export const MAX_UA_LENGTH = 512;
export const MAX_FN_LENGTH = 100;

/** The feature an event needs the server to have announced, or undefined for the base schema. */
export function eventFeature(e: { type: string; name?: unknown; kind?: unknown; instance?: unknown }): Feature | undefined {
  if (e.type === "block") return "runtime_v1";
  if (e.type === "metric") return (RUNTIME_METRIC_NAMES as readonly unknown[]).includes(e.name) ? "runtime_v1" : undefined;
  if (e.type === "lifecycle") return e.kind === "ready" || e.instance !== undefined ? "runtime_v1" : undefined;
  return undefined;
}

export const isRoute = (r: unknown): r is string =>
  typeof r === "string" &&
  r.length <= LIMITS.maxRouteLength &&
  (r === ROUTE_OTHER || r === ROUTE_UNMATCHED || ROUTE_RE.test(r));
export const isHost = (h: unknown): h is string =>
  typeof h === "string" && h.length <= LIMITS.maxHostLength && HOST_RE.test(h);
export const isIdent = (s: unknown, max: number): s is string =>
  typeof s === "string" && s.length <= max && IDENT_RE.test(s);
export const isFramePath = (p: unknown): p is string =>
  typeof p === "string" && p.length <= LIMITS.maxFramePathLength && FRAME_PATH_RE.test(p);
export const isRegion = (s: unknown): s is string => typeof s === "string" && REGION_RE.test(s);
export const isIp = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 45 && (IPV4_RE.test(s) || IPV6_RE.test(s));

// The allowlist scrubber for free text (error messages), shared by SDK and server.
export { cleanCode, identifierPieces, isRouteWord, isScrubbed, isVocabIdentifier, PLACEHOLDERS, scrub, SCRUB_LIMITS, SCRUB_VERSION, SCRUB_VERSIONS } from "./scrub.js";
export type { Placeholder, ScrubOptions } from "./scrub.js";
