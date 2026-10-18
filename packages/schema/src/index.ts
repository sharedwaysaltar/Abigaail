// Abigaail event schema, version 1.
//
// This file is types and constants only: no runtime dependencies, so the SDK can
// import it without pulling a validator into monitored apps. Server-side
// validation lives in ./validate.ts.
//
// Rules this schema encodes (see docs/ROADMAP.md and the project spec):
// - Only named fields exist. Anything not declared here is rejected by the server.
// - No bodies, headers, cookies, query values, emails, names, user IDs or free text.
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

export const METRIC_NAMES = [
  "memory_rss_mb",
  "memory_heap_used_mb",
  "cpu_percent",
  "event_loop_lag_p50_ms",
  "event_loop_lag_p99_ms",
  "sdk_queue_size",
  "sdk_dropped_events",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export const LIFECYCLE_KINDS = ["boot", "heartbeat", "shutdown"] as const;
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
  /** Error class name only, e.g. "TypeError". Never the message. */
  error_type: string;
  route?: string;
  handled: boolean;
  frames?: StackFrame[];
}

export interface OutboundEvent extends BaseEvent {
  type: "outbound";
  /** Hostname only, never path or query. */
  host: string;
  method: HttpMethod;
  status?: number;
  duration_ms: number;
  outcome: OutboundOutcome;
}

export interface MetricEvent extends BaseEvent {
  type: "metric";
  name: MetricName;
  value: number;
}

export interface LifecycleEvent extends BaseEvent {
  type: "lifecycle";
  kind: LifecycleKind;
}

export type AbigaailEvent = RequestEvent | ErrorEvent | OutboundEvent | MetricEvent | LifecycleEvent;
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
