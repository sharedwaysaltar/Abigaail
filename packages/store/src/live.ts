// What the Live view may see of a stored event. This is an allowlist, built
// from the stored row (never from the incoming event, which carries
// `transient`): every field is named here, per type. Visitor hashes, event
// ids, referrers, stack frames and regions never leave through it.

import type { EventRow } from "./rows.js";

interface LiveBase {
  /** Authoritative event time (server clock). */
  ts: number;
  release: string;
}

export type LiveEvent =
  | (LiveBase & { type: "request"; method: string; route: string; status: number; duration_ms: number; bot_class: string | null; flags?: string[] })
  | (LiveBase & { type: "outbound"; host: string; method: string; status: number | null; duration_ms: number; outcome: string })
  | (LiveBase & { type: "error"; error_type: string; route: string | null; handled: boolean })
  | (LiveBase & { type: "metric"; name: string; value: number })
  | (LiveBase & { type: "lifecycle"; kind: string });

/** Every key a live event of each type may carry. Tests hold toLiveEvent to this. */
export const LIVE_FIELDS: Readonly<Record<LiveEvent["type"], readonly string[]>> = {
  request: ["type", "ts", "release", "method", "route", "status", "duration_ms", "bot_class", "flags"],
  outbound: ["type", "ts", "release", "host", "method", "status", "duration_ms", "outcome"],
  error: ["type", "ts", "release", "error_type", "route", "handled"],
  metric: ["type", "ts", "release", "name", "value"],
  lifecycle: ["type", "ts", "release", "kind"],
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
    case "outbound":
      return {
        type: "outbound",
        ...base,
        host: row.host ?? "",
        method: row.method ?? "",
        status: row.status,
        duration_ms: row.duration_ms ?? 0,
        outcome: String(attrs(row).outcome ?? ""),
      };
    case "error":
      return { type: "error", ...base, error_type: row.name ?? "Error", route: row.route, handled: attrs(row).handled === true };
    case "metric":
      return { type: "metric", ...base, name: row.name ?? "", value: row.value ?? 0 };
    case "lifecycle":
      return { type: "lifecycle", ...base, kind: row.name ?? "" };
    default:
      return undefined;
  }
}
