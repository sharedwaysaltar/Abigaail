// What the Live view may see of a stored event. This is an allowlist, built
// from the stored row (never from the incoming event, which carries
// `transient`): every field is named here, per type. Visitor hashes, event
// ids, referrers, stack frames and regions never leave through it. Error
// messages are the stored, scrubbed text (DECISIONS #104).

import type { EventRow } from "./rows.js";

interface LiveBase {
  /** Authoritative event time (server clock). */
  ts: number;
  release: string;
}

export type LiveEvent =
  | (LiveBase & { type: "request"; method: string; route: string; status: number; duration_ms: number; bot_class: string | null; flags?: string[] })
  | (LiveBase & { type: "outbound"; host: string; method: string; status: number | null; duration_ms: number; outcome: string; error_code?: string })
  | (LiveBase & {
      type: "error";
      error_type: string;
      route: string | null;
      handled: boolean;
      message?: string;
      code?: string;
      cause_type?: string;
      cause_code?: string;
      cause_message?: string;
    })
  | (LiveBase & { type: "metric"; name: string; value: number })
  | (LiveBase & { type: "lifecycle"; kind: string })
  | (LiveBase & { type: "block"; route: string | null; count: number; total_ms: number; max_ms: number });

/** Every key a live event of each type may carry. Tests hold toLiveEvent to this. */
export const LIVE_FIELDS: Readonly<Record<LiveEvent["type"], readonly string[]>> = {
  request: ["type", "ts", "release", "method", "route", "status", "duration_ms", "bot_class", "flags"],
  outbound: ["type", "ts", "release", "host", "method", "status", "duration_ms", "outcome", "error_code"],
  error: ["type", "ts", "release", "error_type", "route", "handled", "message", "code", "cause_type", "cause_code", "cause_message"],
  metric: ["type", "ts", "release", "name", "value"],
  lifecycle: ["type", "ts", "release", "kind"],
  block: ["type", "ts", "release", "route", "count", "total_ms", "max_ms"],
};

function attrs(row: EventRow): Record<string, unknown> {
  if (!row.attrs) return {};
  try {
    const v: unknown = JSON.parse(row.attrs);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The live view of one stored row, or undefined for a type it does not know. */
export function toLiveEvent(row: EventRow, release: string): LiveEvent | undefined {
  const base = { ts: row.ts, release };
  switch (row.type) {
    case "request": {
      const flags = attrs(row).flags;
      return {
        type: "request",
        ...base,
        method: row.method ?? "",
        route: row.route ?? "",
        status: row.status ?? 0,
        duration_ms: row.duration_ms ?? 0,
        bot_class: row.bot_class,
        ...(Array.isArray(flags) && flags.length ? { flags: flags.filter((f): f is string => typeof f === "string") } : {}),
      };
    }
    case "outbound": {
      const a = attrs(row);
      return {
        type: "outbound",
        ...base,
        host: row.host ?? "",
        method: row.method ?? "",
        status: row.status,
        duration_ms: row.duration_ms ?? 0,
        outcome: String(a.outcome ?? ""),
        ...(typeof a.error_code === "string" ? { error_code: a.error_code } : {}),
      };
    }
    case "error": {
      const a = attrs(row);
      const text = (k: string) => (typeof a[k] === "string" ? { [k]: a[k] as string } : {});
      return {
        type: "error",
        ...base,
        error_type: row.name ?? "Error",
        route: row.route,
        handled: a.handled === true,
        ...text("message"),
        ...text("code"),
        ...text("cause_type"),
        ...text("cause_code"),
        ...text("cause_message"),
      };
    }
    case "metric":
      return { type: "metric", ...base, name: row.name ?? "", value: row.value ?? 0 };
    case "lifecycle":
      return { type: "lifecycle", ...base, kind: row.name ?? "" };
    case "block": {
      const count = attrs(row).count;
      return {
        type: "block",
        ...base,
        route: row.route,
        count: typeof count === "number" ? count : 1,
        total_ms: row.value ?? 0,
        max_ms: row.duration_ms ?? 0,
      };
    }
    default:
      return undefined;
  }
}
