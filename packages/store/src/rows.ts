// Maps a validated event to an events row. This is an allowlist: every column
// is named here, per event type. `transient` (client IP, user agent) is never
// read, so it cannot reach the database even if a future field is added.

import type { AbigaailEvent } from "@abigaail/schema";

/** Values the ingest server derives for one event. */
export interface Derived {
  /** Authoritative event time (server clock, epoch ms). */
  ts: number;
  visitor_hash?: string | null;
  browser?: string | null;
  bot_class?: string | null;
}

export interface EventRow {
  event_id: string;
  ts: number;
  client_ts: number;
  type: string;
  route: string | null;
  method: string | null;
  status: number | null;
  duration_ms: number | null;
  host: string | null;
  name: string | null;
  value: number | null;
  sample_rate: number | null;
  visitor_hash: string | null;
  browser: string | null;
  bot_class: string | null;
  attrs: string | null;
  /** event_id of the inbound request (outbound and error events only). */
  parent_id: string | null;
}

function attrsJson(attrs: Record<string, unknown>): string | null {
  const kept = Object.entries(attrs).filter(([, v]) => v !== undefined);
  return kept.length ? JSON.stringify(Object.fromEntries(kept)) : null;
}

export function toRow(event: AbigaailEvent, derived: Derived): EventRow {
  const row: EventRow = {
    event_id: event.event_id,
    ts: derived.ts,
    client_ts: event.client_ts,
    type: event.type,
    route: null,
    method: null,
    status: null,
    duration_ms: null,
    host: null,
    name: null,
    value: null,
    sample_rate: null,
    visitor_hash: null,
    browser: null,
    bot_class: null,
    attrs: null,
    parent_id: null,
  };
  switch (event.type) {
    case "request":
      row.method = event.method;
      row.route = event.route;
      row.status = event.status;
      row.duration_ms = event.duration_ms;
      row.sample_rate = event.sample_rate ?? null;
      row.visitor_hash = derived.visitor_hash ?? null;
      row.browser = derived.browser ?? null;
      row.bot_class = derived.bot_class ?? null;
      row.attrs = attrsJson({
        req_bytes: event.req_bytes,
        res_bytes: event.res_bytes,
        referrer_domain: event.referrer_domain,
        flags: event.flags?.length ? event.flags : undefined,
      });
      break;
    case "error":
      row.route = event.route ?? null;
      row.name = event.error_type;
      row.attrs = attrsJson({
        handled: event.handled,
        frames: event.frames?.map((f) => ({ file: f.file, line: f.line, col: f.col, fn: f.fn })),
      });
      row.parent_id = event.parent_id ?? null;
      break;
    case "outbound":
      row.host = event.host;
      row.method = event.method;
      row.status = event.status ?? null;
      row.duration_ms = event.duration_ms;
      row.attrs = attrsJson({ outcome: event.outcome });
      row.parent_id = event.parent_id ?? null;
      break;
    case "metric":
      row.name = event.name;
      row.value = event.value;
      break;
    case "lifecycle":
      row.name = event.kind;
      row.attrs = attrsJson({ region: event.region });
      break;
  }
  return row;
}
