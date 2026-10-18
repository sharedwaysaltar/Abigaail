// Server-side validation of ingest batches. This is the server half of the
// allowlist: every object is strict, so an unknown field (email, body, headers,
// cookie, ...) rejects the whole batch instead of being silently stored.

import { z } from "zod";
import {
  ENVIRONMENTS,
  HTTP_METHODS,
  LIFECYCLE_KINDS,
  LIMITS,
  METRIC_NAMES,
  OUTBOUND_OUTCOMES,
  REQUEST_FLAGS,
  ROUTE_OTHER,
  ROUTE_UNMATCHED,
  SUPPORTED_SCHEMA_VERSIONS,
  type Batch,
} from "./index.js";

// A normalised route: path characters plus [param] placeholders. No query
// string, no fragment, no percent-encoding, no spaces, no "@".
const ROUTE_RE = /^\/[A-Za-z0-9._~\-[\]/]*$/;
const route = z
  .string()
  .max(LIMITS.maxRouteLength)
  .refine((r) => r === ROUTE_OTHER || r === ROUTE_UNMATCHED || ROUTE_RE.test(r), {
    message: "route must be a normalised pattern",
  });

// Hostnames only: letters, digits, dots and hyphens (IDNs arrive as punycode).
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
const host = z.string().max(LIMITS.maxHostLength).regex(HOST_RE, "must be a bare hostname");

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;
// Release strings: git SHAs, semver, build ids. No spaces or free text.
const RELEASE_RE = /^[A-Za-z0-9._\-+]+$/;
// Project-relative frame paths. Absolute paths would leak usernames and hostnames.
const FRAME_PATH_RE = /^(?![/\\])(?![A-Za-z]:)[A-Za-z0-9._\-/@[\]()]+$/;

const eventId = z.uuid();
const clientTs = z.number().int().nonnegative();
const method = z.enum(HTTP_METHODS);
const durationMs = z.number().nonnegative().max(24 * 60 * 60 * 1000);
const bytes = z.number().int().nonnegative();

const transient = z
  .strictObject({
    ip: z.union([z.ipv4(), z.ipv6()]).optional(),
    ua: z.string().max(512).optional(),
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
        fn: z.string().max(100).regex(IDENT_RE).optional(),
      }),
    )
    .max(LIMITS.maxStackFrames)
    .optional(),
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
});

export const metricEventSchema = z.strictObject({
  type: z.literal("metric"),
  event_id: eventId,
  client_ts: clientTs,
  name: z.enum(METRIC_NAMES),
  value: z.number().finite(),
});

export const lifecycleEventSchema = z.strictObject({
  type: z.literal("lifecycle"),
  event_id: eventId,
  client_ts: clientTs,
  kind: z.enum(LIFECYCLE_KINDS),
});

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
