// Server-side validation of ingest batches. This is the server half of the
// allowlist: every object is strict, so an unknown field (email, body, headers,
// cookie, ...) rejects the whole batch instead of being silently stored.

import { z } from "zod";
import {
  COMMIT_RE,
  ENVIRONMENTS,
  EVENT_ID_RE,
  FRAME_PATH_RE,
  HOST_RE,
  HTTP_METHODS,
  IDENT_RE,
  INSTANCE_RE,
  IPV4_RE,
  IPV6_RE,
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
  REGION_RE,
  RELEASE_RE,
  REQUEST_FLAGS,
  ROUTE_OTHER,
  ROUTE_RE,
  ROUTE_UNMATCHED,
  SHA256_RE,
  SUPPORTED_SCHEMA_VERSIONS,
  type Batch,
} from "./index.js";
import { cleanCode } from "./scrub.js";

// Patterns are shared with the SDK sanitiser (see ./index.ts).
const route = z
  .string()
  .max(LIMITS.maxRouteLength)
  .refine((r) => r === ROUTE_OTHER || r === ROUTE_UNMATCHED || ROUTE_RE.test(r), {
    message: "route must be a normalised pattern",
  });

const host = z.string().max(LIMITS.maxHostLength).regex(HOST_RE, "must be a bare hostname");

const eventId = z.string().regex(EVENT_ID_RE, "must be a UUID");
/** An error code by pattern only. */
const code = z.string().max(LIMITS.maxCodeLength).refine((c) => cleanCode(c) === c, "must be an error code");
/**
 * Scrubbed text. The server scrubs it again with its own rules before storing
 * (apps/server), so a different scrubber version never loses a batch (#19).
 */
const scrubbed = z.string().min(1).max(LIMITS.maxMessageLength);
const clientTs = z.number().int().nonnegative();
const method = z.enum(HTTP_METHODS);
const durationMs = z.number().nonnegative().max(MAX_DURATION_MS);
const bytes = z.number().int().nonnegative();

/** A stack frame: project-relative path and identifier only (DECISIONS #7). */
export const frameSchema = z.strictObject({
  file: z.string().max(LIMITS.maxFramePathLength).regex(FRAME_PATH_RE, "must be a relative path"),
  line: z.number().int().nonnegative(),
  col: z.number().int().nonnegative().optional(),
  fn: z.string().max(MAX_FN_LENGTH).regex(IDENT_RE).optional(),
});
const errorType = z.string().max(LIMITS.maxErrorTypeLength).regex(IDENT_RE, "must be an error class name");
const megabytes = z.number().nonnegative().max(MAX_MEMORY_MB);

const transient = z
  .strictObject({
    ip: z.string().max(45).refine((ip) => IPV4_RE.test(ip) || IPV6_RE.test(ip), "must be an IP address").optional(),
    ua: z.string().max(MAX_UA_LENGTH).optional(),
  })
  .optional();

export const requestEventSchema = z.strictObject({
  type: z.literal("request"),
  event_id: eventId,
  client_ts: clientTs,
  method,
  route,
  status: z.number().int().min(100).max(599),
  duration_ms: durationMs,
  req_bytes: bytes.optional(),
  res_bytes: bytes.optional(),
  sample_rate: z.number().gt(0).max(1).optional(),
  referrer_domain: host.optional(),
  flags: z.array(z.enum(REQUEST_FLAGS)).max(REQUEST_FLAGS.length).optional(),
  transient,
});

export const errorEventSchema = z.strictObject({
  type: z.literal("error"),
  event_id: eventId,
  client_ts: clientTs,
  error_type: errorType,
  route: route.optional(),
  handled: z.boolean(),
  frames: z.array(frameSchema).max(LIMITS.maxStackFrames).optional(),
  message: scrubbed.optional(),
  code: code.optional(),
  cause_type: errorType.optional(),
  cause_code: code.optional(),
  cause_message: scrubbed.optional(),
  scrub_version: z.number().int().positive().max(1000).optional(),
  parent_id: eventId.optional(),
});

export const outboundEventSchema = z.strictObject({
  type: z.literal("outbound"),
  event_id: eventId,
  client_ts: clientTs,
  host,
  method,
  status: z.number().int().min(100).max(599).optional(),
  duration_ms: durationMs,
  outcome: z.enum(OUTBOUND_OUTCOMES),
  error_code: code.optional(),
  parent_id: eventId.optional(),
});

export const metricEventSchema = z.strictObject({
  type: z.literal("metric"),
  event_id: eventId,
  client_ts: clientTs,
  name: z.enum(METRIC_NAMES),
  value: z.number().finite(),
});

export const prevExitSchema = z.strictObject({
  code: z.number().int().min(0).max(MAX_EXIT_CODE),
  error_type: errorType.optional(),
  frame: frameSchema.optional(),
  heap_mb: megabytes.optional(),
  uptime_s: z.number().int().nonnegative().max(10 * 365 * 86_400).optional(),
});

/** Fields `ready` alone may carry. */
const READY_ONLY = ["boot_id", "startup_ms", "heap_limit_mb", "memory_limit_mb", "prev_exit"] as const;

export const lifecycleEventSchema = z
  .strictObject({
    type: z.literal("lifecycle"),
    event_id: eventId,
    client_ts: clientTs,
    kind: z.enum(LIFECYCLE_KINDS),
    region: z.string().regex(REGION_RE, "must be a region code").optional(),
    instance: z.string().regex(INSTANCE_RE, "must be an instance id").optional(),
    boot_id: eventId.optional(),
    startup_ms: durationMs.optional(),
    heap_limit_mb: megabytes.optional(),
    memory_limit_mb: megabytes.optional(),
    prev_exit: prevExitSchema.optional(),
  })
  .refine((e) => e.region === undefined || e.kind === "boot", { message: "region is sent on boot only", path: ["region"] })
  // The boot event stays exactly as before runtime_v1, so an older server accepts it.
  .refine((e) => e.instance === undefined || e.kind !== "boot", { message: "instance is not sent on boot", path: ["instance"] })
  .superRefine((e, ctx) => {
    if (e.kind === "ready") {
      if (e.boot_id === undefined) ctx.addIssue({ code: "custom", message: "ready needs boot_id", path: ["boot_id"] });
      return;
    }
    for (const k of READY_ONLY) {
      if (e[k] !== undefined) ctx.addIssue({ code: "custom", message: `${k} is sent on ready only`, path: [k] });
    }
  });

export const blockEventSchema = z.strictObject({
  type: z.literal("block"),
  event_id: eventId,
  client_ts: clientTs,
  route: route.optional(),
  count: z.number().int().min(1).max(1_000_000),
  total_ms: durationMs,
  max_ms: durationMs,
});

/** A profile frame: the stack-frame rules (relative path or placeholder, identifier), no column. */
const profileFrame = z.strictObject({
  file: z.string().max(LIMITS.maxFramePathLength).regex(FRAME_PATH_RE, "must be a relative path"),
  line: z.number().int().nonnegative(),
  fn: z.string().max(MAX_FN_LENGTH).regex(IDENT_RE).optional(),
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const profileEventSchema = z
  .strictObject({
    type: z.literal("profile"),
    event_id: eventId,
    client_ts: clientTs,
    kind: z.enum(PROFILE_KINDS),
    route: route.optional(),
    window_ms: durationMs,
    samples: count,
    samples_concurrent: count.optional(),
    samples_idle: count.optional(),
    frames: z.array(profileFrame).max(LIMITS.maxProfileFrames),
    stacks: z
      .array(z.strictObject({ frames: z.array(z.number().int().nonnegative()).min(1).max(LIMITS.maxProfileDepth), weight: count }))
      .max(LIMITS.maxProfileStacks),
  })
  .superRefine((e, ctx) => {
    if (e.stacks.some((s) => s.frames.some((i) => i >= e.frames.length))) ctx.addIssue({ code: "custom", message: "stack refers to a missing frame", path: ["stacks"] });
    if (e.route !== undefined && e.kind !== "cpu") ctx.addIssue({ code: "custom", message: "route is sent on cpu profiles only", path: ["route"] });
    if ((e.samples_concurrent !== undefined || e.samples_idle !== undefined) && (e.kind !== "cpu" || e.route !== undefined)) {
      ctx.addIssue({ code: "custom", message: "concurrent and idle samples are sent on the whole-app cpu profile only", path: ["samples_concurrent"] });
    }
    if (JSON.stringify(e).length > LIMITS.maxProfileBytes) ctx.addIssue({ code: "custom", message: "profile too large", path: [] });
  });

export const deployEventSchema = z
  .strictObject({
    type: z.literal("deploy"),
    event_id: eventId,
    client_ts: clientTs,
    commit: z.string().regex(COMMIT_RE, "must be a git commit SHA").optional(),
    previous: z.string().min(1).max(LIMITS.maxReleaseLength).regex(RELEASE_RE).optional(),
    lockfile: z.string().regex(SHA256_RE, "must be a SHA-256 hex digest").optional(),
  })
  .refine((e) => e.commit !== undefined || e.previous !== undefined || e.lockfile !== undefined, { message: "deploy carries nothing", path: [] });

export const eventSchema = z.discriminatedUnion("type", [
  requestEventSchema,
  errorEventSchema,
  outboundEventSchema,
  metricEventSchema,
  lifecycleEventSchema,
  blockEventSchema,
  profileEventSchema,
  deployEventSchema,
]);

export const batchSchema = z.strictObject({
  schema_version: z.number().int().refine((v) => SUPPORTED_SCHEMA_VERSIONS.includes(v), {
    message: `schema_version must be one of ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
  }),
  sdk: z.strictObject({
    name: z.string().max(64).regex(/^[a-z0-9@/._-]+$/),
    version: z.string().max(32).regex(RELEASE_RE),
  }),
  release: z.string().min(1).max(LIMITS.maxReleaseLength).regex(RELEASE_RE),
  environment: z.enum(ENVIRONMENTS),
  sent_at: clientTs.optional(),
  events: z.array(eventSchema).min(1).max(LIMITS.maxEventsPerBatch),
});

export type ValidationResult =
  | { ok: true; batch: Batch }
  | { ok: false; issues: { path: string; message: string }[] };

/**
 * Validate an already-parsed JSON body. Issue messages name the offending path
 * but never echo the rejected value, so a rejected secret is not logged.
 */
export function validateBatch(input: unknown): ValidationResult {
  const result = batchSchema.safeParse(input);
  if (result.success) return { ok: true, batch: result.data as Batch };
  return {
    ok: false,
    issues: result.error.issues.slice(0, 20).map((i) => ({
      path: i.path.join("."),
      // Key names are safe to report; values never are.
      message: i.code === "unrecognized_keys" ? `field not allowed: ${i.keys.join(", ")}` : i.message,
    })),
  };
}
