// Server-side validation of ingest batches. This is the server half of the
// allowlist: every object is strict, so an unknown field (email, body, headers,
// cookie, ...) rejects the whole batch instead of being silently stored.

import { z } from "zod";
import {
  ENVIRONMENTS,
  EVENT_ID_RE,
  FRAME_PATH_RE,
  HOST_RE,
  HTTP_METHODS,
  IDENT_RE,
  IPV4_RE,
  IPV6_RE,
  LIFECYCLE_KINDS,
  LIMITS,
  MAX_DURATION_MS,
  MAX_FN_LENGTH,
  MAX_UA_LENGTH,
  METRIC_NAMES,
  OUTBOUND_OUTCOMES,
  REGION_RE,
  RELEASE_RE,
  REQUEST_FLAGS,
  ROUTE_OTHER,
  ROUTE_RE,
  ROUTE_UNMATCHED,
  SUPPORTED_SCHEMA_VERSIONS,
  type Batch,
} from "./index.js";

// Patterns are shared with the SDK sanitiser (see ./index.ts).
const route = z
  .string()
  .max(LIMITS.maxRouteLength)
  .refine((r) => r === ROUTE_OTHER || r === ROUTE_UNMATCHED || ROUTE_RE.test(r), {
    message: "route must be a normalised pattern",
  });

const host = z.string().max(LIMITS.maxHostLength).regex(HOST_RE, "must be a bare hostname");

const eventId = z.string().regex(EVENT_ID_RE, "must be a UUID");
const clientTs = z.number().int().nonnegative();
const method = z.enum(HTTP_METHODS);
const durationMs = z.number().nonnegative().max(MAX_DURATION_MS);
const bytes = z.number().int().nonnegative();

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
  error_type: z.string().max(LIMITS.maxErrorTypeLength).regex(IDENT_RE, "must be an error class name"),
  route: route.optional(),
  handled: z.boolean(),
  frames: z
    .array(
      z.strictObject({
        file: z.string().max(LIMITS.maxFramePathLength).regex(FRAME_PATH_RE, "must be a relative path"),
        line: z.number().int().nonnegative(),
        col: z.number().int().nonnegative().optional(),
        fn: z.string().max(MAX_FN_LENGTH).regex(IDENT_RE).optional(),
      }),
    )
    .max(LIMITS.maxStackFrames)
    .optional(),
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
  parent_id: eventId.optional(),
});

export const metricEventSchema = z.strictObject({
  type: z.literal("metric"),
  event_id: eventId,
  client_ts: clientTs,
  name: z.enum(METRIC_NAMES),
  value: z.number().finite(),
});

export const lifecycleEventSchema = z
  .strictObject({
    type: z.literal("lifecycle"),
    event_id: eventId,
    client_ts: clientTs,
    kind: z.enum(LIFECYCLE_KINDS),
    region: z.string().regex(REGION_RE, "must be a region code").optional(),
  })
  .refine((e) => e.region === undefined || e.kind === "boot", { message: "region is sent on boot only", path: ["region"] });

export const eventSchema = z.discriminatedUnion("type", [
  requestEventSchema,
  errorEventSchema,
  outboundEventSchema,
  metricEventSchema,
  lifecycleEventSchema,
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
