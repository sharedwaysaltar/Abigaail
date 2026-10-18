import {
  EVENT_ID_RE,
  HOST_INVALID,
  HOST_IP_LITERAL,
  HTTP_METHODS,
  LIFECYCLE_KINDS,
  LIMITS,
  MAX_DURATION_MS,
  MAX_FN_LENGTH,
  MAX_UA_LENGTH,
  METRIC_NAMES,
  OUTBOUND_OUTCOMES,
  REQUEST_FLAGS,
  ROUTE_OTHER,
  isFramePath,
  isHost,
  isIdent,
  isIp,
  isRoute,
  type AbigaailEvent,
  type ErrorEvent,
  type OutboundEvent,
  type RequestEvent,
  type RequestFlag,
  type StackFrame,
  type Transient,
} from "@abigaail/schema";

// Client half of the allowlist. Every event is rebuilt from the named fields of
// its type, so an unknown key never reaches the queue, and each value is mapped
// to something ingest accepts or the event is dropped. The patterns are the
// ones the server validates with, so one bad event can no longer get a whole
// batch rejected (DECISIONS #19).

type Raw = Record<string, unknown>;

const has = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isStatus = (v: unknown): v is number => isInt(v, 100, 599);
const isDuration = (v: unknown): v is number => isNum(v) && v >= 0 && v <= MAX_DURATION_MS;

const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** One spelling per address; IPv4-mapped IPv6 (Node's dual-stack form) becomes plain IPv4. */
export function unmapIp(ip: string): string {
  return IPV4_MAPPED_RE.exec(ip)?.[1] ?? ip;
}

/** Hostname for an outbound event: IP literals and anything invalid become placeholders. */
export function cleanHost(host: unknown): string {
  if (typeof host !== "string") return HOST_INVALID;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIp(unmapIp(bare)) || isIp(bare.split("%")[0])) return HOST_IP_LITERAL;
  return isHost(host) ? host.toLowerCase() : HOST_INVALID;
}

function cleanTransient(t: unknown): Transient | undefined {
  if (!t || typeof t !== "object") return undefined;
  const raw = t as Raw;
  const out: Transient = {};
  if (typeof raw.ip === "string") {
    const ip = unmapIp(raw.ip);
    if (isIp(ip)) out.ip = ip;
  }
  if (typeof raw.ua === "string" && raw.ua) out.ua = raw.ua.slice(0, MAX_UA_LENGTH);
  return out.ip !== undefined || out.ua !== undefined ? out : undefined;
}

function cleanFrames(frames: unknown): StackFrame[] | undefined {
  if (!Array.isArray(frames)) return undefined;
  const out: StackFrame[] = [];
  for (const f of frames) {
    if (out.length >= LIMITS.maxStackFrames) break;
    if (!f || typeof f !== "object") continue;
    const raw = f as Raw;
    if (!isFramePath(raw.file) || !isInt(raw.line, 0)) continue;
    const frame: StackFrame = { file: raw.file, line: raw.line };
    if (isInt(raw.col, 0)) frame.col = raw.col;
    if (isIdent(raw.fn, MAX_FN_LENGTH)) frame.fn = raw.fn;
    out.push(frame);
  }
  return out.length ? out : undefined;
}

function cleanFlags(flags: unknown): RequestFlag[] | undefined {
  if (!Array.isArray(flags)) return undefined;
  const out = [...new Set(flags.filter((f): f is RequestFlag => has(REQUEST_FLAGS, f)))];
  return out.length ? out : undefined;
}

/**
 * Returns a clean copy of `input` that ingest will accept, or undefined when the
 * event cannot be repaired (the caller counts it as invalid). Never throws.
 */
export function sanitizeEvent(input: unknown, eventId: () => string, now: () => number): AbigaailEvent | undefined {
  if (!input || typeof input !== "object") return undefined;
  const e = input as Raw;
  const event_id = typeof e.event_id === "string" && EVENT_ID_RE.test(e.event_id) ? e.event_id : eventId();
  const client_ts = isInt(e.client_ts, 0) ? e.client_ts : Math.max(0, Math.floor(now()));
  const base = { event_id, client_ts };

  switch (e.type) {
    case "request": {
      if (!has(HTTP_METHODS, e.method) || !isStatus(e.status) || !isDuration(e.duration_ms)) return undefined;
      const out: RequestEvent = {
        type: "request",
        ...base,
        method: e.method,
        route: isRoute(e.route) ? e.route : ROUTE_OTHER,
        status: e.status,
        duration_ms: e.duration_ms,
      };
      if (isInt(e.req_bytes, 0)) out.req_bytes = e.req_bytes;
      if (isInt(e.res_bytes, 0)) out.res_bytes = e.res_bytes;
      if (isNum(e.sample_rate) && e.sample_rate > 0 && e.sample_rate <= 1) out.sample_rate = e.sample_rate;
      if (isHost(e.referrer_domain)) out.referrer_domain = e.referrer_domain.toLowerCase();
      const flags = cleanFlags(e.flags);
      if (flags) out.flags = flags;
      const transient = cleanTransient(e.transient);
      if (transient) out.transient = transient;
      return out;
    }
    case "error": {
      if (typeof e.handled !== "boolean") return undefined;
      const out: ErrorEvent = {
        type: "error",
        ...base,
        error_type: isIdent(e.error_type, LIMITS.maxErrorTypeLength) ? e.error_type : "Error",
        handled: e.handled,
      };
      if (e.route !== undefined) out.route = isRoute(e.route) ? e.route : ROUTE_OTHER;
      const frames = cleanFrames(e.frames);
      if (frames) out.frames = frames;
      return out;
    }
    case "outbound": {
      if (!has(HTTP_METHODS, e.method) || !isDuration(e.duration_ms) || !has(OUTBOUND_OUTCOMES, e.outcome)) {
        return undefined;
      }
      const out: OutboundEvent = {
        type: "outbound",
        ...base,
        host: cleanHost(e.host),
        method: e.method,
        duration_ms: e.duration_ms,
        outcome: e.outcome,
      };
      if (isStatus(e.status)) out.status = e.status;
      return out;
    }
    case "metric":
      if (!has(METRIC_NAMES, e.name) || !isNum(e.value)) return undefined;
      return { type: "metric", ...base, name: e.name, value: e.value };
    case "lifecycle":
      if (!has(LIFECYCLE_KINDS, e.kind)) return undefined;
      return { type: "lifecycle", ...base, kind: e.kind };
    default:
      return undefined;
  }
}
