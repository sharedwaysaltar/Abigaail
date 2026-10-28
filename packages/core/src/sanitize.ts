import {
  COMMIT_RE,
  EVENT_ID_RE,
  HOST_INVALID,
  HOST_IP_LITERAL,
  HTTP_METHODS,
  INSTANCE_RE,
  LIFECYCLE_KINDS,
  LIMITS,
  MAX_DURATION_MS,
  MAX_EXIT_CODE,
  MAX_FN_LENGTH,
  MAX_MEMORY_MB,
  MAX_UA_LENGTH,
  METRIC_NAMES,
  OUTBOUND_OUTCOMES,
  PROFILE_KINDS,
  RELEASE_RE,
  REQUEST_FLAGS,
  ROUTE_OTHER,
  SCRUB_VERSION,
  SHA256_RE,
  cleanCode,
  isFramePath,
  isHost,
  isIdent,
  isIp,
  isRegion,
  isRoute,
  scrub,
  type AbigaailEvent,
  type BlockEvent,
  type DeployEvent,
  type ErrorEvent,
  type LifecycleEvent,
  type OutboundEvent,
  type PrevExit,
  type ProfileEvent,
  type ProfileFrame,
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

/** What sanitizing free text needs from the client (DECISIONS #101-#105). */
export interface SanitizeContext {
  /** false: no error message is sent at all (errorMessages: false). Default true. */
  messages?: boolean;
  /** Takes one scrub from the budget; false when it is spent (the error goes out without its message). */
  scrubBudget?: () => boolean;
  /** The app's own outbound hosts: the only hostnames a message may keep. */
  knownHost?: (host: string) => boolean;
  /** Each outbound host that is sent, so the client can remember it. */
  onHost?: (host: string) => void;
}

const has = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isStatus = (v: unknown): v is number => isInt(v, 100, 599);
const isDuration = (v: unknown): v is number => isNum(v) && v >= 0 && v <= MAX_DURATION_MS;
const isEventId = (v: unknown): v is string => typeof v === "string" && EVENT_ID_RE.test(v);
const isMegabytes = (v: unknown): v is number => isNum(v) && v >= 0 && v <= MAX_MEMORY_MB;

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

/** A region code in its one spelling (uppercase), or undefined if it is not one. */
export function cleanRegion(region: unknown): string | undefined {
  if (typeof region !== "string") return undefined;
  const up = region.trim().toUpperCase();
  return isRegion(up) ? up : undefined;
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

/** One frame with a relative path and an identifier, or undefined. */
export function cleanFrame(f: unknown): StackFrame | undefined {
  if (!f || typeof f !== "object") return undefined;
  const raw = f as Raw;
  if (!isFramePath(raw.file) || !isInt(raw.line, 0)) return undefined;
  const frame: StackFrame = { file: raw.file, line: raw.line };
  if (isInt(raw.col, 0)) frame.col = raw.col;
  if (isIdent(raw.fn, MAX_FN_LENGTH)) frame.fn = raw.fn;
  return frame;
}

function cleanFrames(frames: unknown): StackFrame[] | undefined {
  if (!Array.isArray(frames)) return undefined;
  const out: StackFrame[] = [];
  for (const f of frames) {
    if (out.length >= LIMITS.maxStackFrames) break;
    const frame = cleanFrame(f);
    if (frame) out.push(frame);
  }
  return out.length ? out : undefined;
}

/** A crash record's fields, each kept only if valid; undefined without a valid exit code. */
export function cleanPrevExit(p: unknown): PrevExit | undefined {
  if (!p || typeof p !== "object") return undefined;
  const raw = p as Raw;
  if (!isInt(raw.code, 0, MAX_EXIT_CODE)) return undefined;
  const out: PrevExit = { code: raw.code };
  if (isIdent(raw.error_type, LIMITS.maxErrorTypeLength)) out.error_type = raw.error_type;
  const frame = cleanFrame(raw.frame);
  if (frame) out.frame = frame;
  if (isMegabytes(raw.heap_mb)) out.heap_mb = raw.heap_mb;
  if (isInt(raw.uptime_s, 0, 10 * 365 * 86_400)) out.uptime_s = raw.uptime_s;
  return out;
}

/**
 * A profile with every frame checked like a stack frame (no column) and every
 * stack pointing at a kept frame; undefined if anything is off or it is too
 * large. The profiler builds valid ones; this keeps one bad profile from
 * losing a batch (#19).
 */
function cleanProfile(e: Raw, base: { event_id: string; client_ts: number }): ProfileEvent | undefined {
  if (!has(PROFILE_KINDS, e.kind) || !isDuration(e.window_ms) || !isInt(e.samples, 0)) return undefined;
  if (!Array.isArray(e.frames) || !Array.isArray(e.stacks)) return undefined;
  if (e.frames.length > LIMITS.maxProfileFrames || e.stacks.length > LIMITS.maxProfileStacks) return undefined;
  const frames: ProfileFrame[] = [];
  for (const f of e.frames) {
    const raw = (f ?? {}) as Raw;
    if (!isFramePath(raw.file) || !isInt(raw.line, 0)) return undefined;
    frames.push({ file: raw.file, line: raw.line, ...(isIdent(raw.fn, MAX_FN_LENGTH) ? { fn: raw.fn } : {}) });
  }
  const stacks: ProfileEvent["stacks"] = [];
  for (const s of e.stacks) {
    const raw = (s ?? {}) as Raw;
    const idx = raw.frames;
    if (!Array.isArray(idx) || !idx.length || idx.length > LIMITS.maxProfileDepth || !isInt(raw.weight, 0)) return undefined;
    if (!idx.every((i) => isInt(i, 0, frames.length - 1))) return undefined;
    stacks.push({ frames: idx as number[], weight: raw.weight });
  }
  const out: ProfileEvent = { type: "profile", ...base, kind: e.kind, window_ms: e.window_ms, samples: e.samples, frames, stacks };
  if (e.kind === "cpu" && e.route !== undefined) out.route = isRoute(e.route) ? e.route : ROUTE_OTHER;
  if (e.kind === "cpu" && out.route === undefined) {
    if (isInt(e.samples_concurrent, 0)) out.samples_concurrent = e.samples_concurrent;
    if (isInt(e.samples_idle, 0)) out.samples_idle = e.samples_idle;
  }
  return JSON.stringify(out).length <= LIMITS.maxProfileBytes ? out : undefined;
}

function cleanLifecycle(e: Raw, base: { event_id: string; client_ts: number }): LifecycleEvent | undefined {
  if (!has(LIFECYCLE_KINDS, e.kind)) return undefined;
  const out: LifecycleEvent = { type: "lifecycle", ...base, kind: e.kind };
  if (e.kind === "boot") {
    // Boot stays exactly as before runtime_v1 (no instance), so any server accepts it.
    const region = cleanRegion(e.region);
    if (region) out.region = region;
    return out;
  }
  if (typeof e.instance === "string" && INSTANCE_RE.test(e.instance)) out.instance = e.instance;
  if (e.kind !== "ready") return out;
  if (!isEventId(e.boot_id)) return undefined;
  out.boot_id = e.boot_id;
  if (isDuration(e.startup_ms)) out.startup_ms = e.startup_ms;
  if (isMegabytes(e.heap_limit_mb)) out.heap_limit_mb = e.heap_limit_mb;
  if (isMegabytes(e.memory_limit_mb)) out.memory_limit_mb = e.memory_limit_mb;
  const prev = cleanPrevExit(e.prev_exit);
  if (prev) out.prev_exit = prev;
  return out;
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
export function sanitizeEvent(input: unknown, eventId: () => string, now: () => number, ctx: SanitizeContext = {}): AbigaailEvent | undefined {
  if (!input || typeof input !== "object") return undefined;
  const e = input as Raw;
  const event_id = isEventId(e.event_id) ? e.event_id : eventId();
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
      const code = cleanCode(e.code);
      if (code) out.code = code;
      if (isIdent(e.cause_type, LIMITS.maxErrorTypeLength)) out.cause_type = e.cause_type;
      const causeCode = cleanCode(e.cause_code);
      if (causeCode) out.cause_code = causeCode;
      // Free text only through the scrubber, and only within the budget.
      if (ctx.messages !== false) {
        const opts = ctx.knownHost ? { knownHost: ctx.knownHost } : {};
        for (const field of ["message", "cause_message"] as const) {
          if (typeof e[field] !== "string" || !e[field] || (ctx.scrubBudget && !ctx.scrubBudget())) continue;
          const text = scrub(e[field], opts);
          if (text) out[field] = text;
        }
        if (out.message || out.cause_message) out.scrub_version = SCRUB_VERSION;
      }
      if (isEventId(e.parent_id)) out.parent_id = e.parent_id;
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
      const errorCode = out.outcome === "ok" ? undefined : cleanCode(e.error_code);
      if (errorCode) out.error_code = errorCode;
      if (isEventId(e.parent_id)) out.parent_id = e.parent_id;
      if (out.host !== HOST_INVALID && out.host !== HOST_IP_LITERAL) ctx.onHost?.(out.host);
      return out;
    }
    case "metric":
      if (!has(METRIC_NAMES, e.name) || !isNum(e.value)) return undefined;
      return { type: "metric", ...base, name: e.name, value: e.value };
    case "lifecycle":
      return cleanLifecycle(e, base);
    case "profile":
      return cleanProfile(e, base);
    case "block": {
      if (!isInt(e.count, 1, 1_000_000) || !isDuration(e.total_ms) || !isDuration(e.max_ms)) return undefined;
      const out: BlockEvent = { type: "block", ...base, count: e.count, total_ms: e.total_ms, max_ms: e.max_ms };
      if (e.route !== undefined) out.route = isRoute(e.route) ? e.route : ROUTE_OTHER;
      return out;
    }
    case "deploy":
      return cleanDeploy(e, base);
    default:
      return undefined;
  }
}

/** Deploy metadata (deploy_v1): each value kept only if it matches its pattern; nothing left drops the event. */
function cleanDeploy(e: Raw, base: { event_id: string; client_ts: number }): DeployEvent | undefined {
  const out: DeployEvent = { type: "deploy", ...base };
  if (typeof e.commit === "string" && COMMIT_RE.test(e.commit)) out.commit = e.commit;
  if (typeof e.previous === "string" && e.previous.length <= LIMITS.maxReleaseLength && RELEASE_RE.test(e.previous)) out.previous = e.previous;
  if (typeof e.lockfile === "string" && SHA256_RE.test(e.lockfile)) out.lockfile = e.lockfile;
  return out.commit !== undefined || out.previous !== undefined || out.lockfile !== undefined ? out : undefined;
}
