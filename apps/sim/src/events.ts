// Turns a simulated request and the demo's answer into the events the SDK
// would send and the values ingest would derive, for seeded history and the
// replay tests. The live run never uses this: there the real SDK and ingest
// produce them.

import { createHash } from "node:crypto";
import type { AbigaailEvent, Batch, Environment, LifecycleEvent, MetricName } from "@abigaail/schema";
import { requestFlags } from "@abigaail/node";
import { classifyUserAgent } from "@abigaail/server";
import type { Derived } from "@abigaail/store";
import type { Outcome } from "./model.js";
import { uuid, type Rng } from "./random.js";
import type { SimRequest } from "./traffic.js";

export interface Item {
  event: AbigaailEvent;
  derived: Derived;
}

export const SIM_SDK = { name: "@abigaail/sim", version: "0.1.0" };
export const ENVIRONMENT: Environment = "development";

/** A stand-in for ingest's daily-salted visitor hash: stable per UA and UTC day. */
function visitorHash(ua: string, ts: number): string {
  return createHash("sha256").update(`${new Date(ts).toISOString().slice(0, 10)}\n${ua}`).digest("hex").slice(0, 32);
}

/** Events for one request: the request itself, plus its outbound call and error, as the SDK reports them. */
export function requestItems(r: Rng, req: SimRequest, out: Outcome, ts = req.at): Item[] {
  const { bot_class, browser } = classifyUserAgent(req.ua);
  const flags = requestFlags(req.path, out.status);
  const event_id = uuid(r);
  const items: Item[] = [];
  const end = Math.round(ts + out.duration);
  if (out.outbound) {
    const o = out.outbound;
    items.push({
      event: {
        type: "outbound", event_id: uuid(r), client_ts: end, host: o.host, method: "GET",
        status: o.status, duration_ms: Math.round(o.duration), outcome: "ok", parent_id: event_id,
      },
      derived: { ts: end },
    });
  }
  if (out.error) {
    items.push({
      event: { type: "error", event_id: uuid(r), client_ts: end, error_type: out.error, route: out.route, handled: true, parent_id: event_id },
      derived: { ts: end },
    });
  }
  items.push({
    event: {
      type: "request", event_id, client_ts: end, method: "GET", route: out.route, status: out.status,
      duration_ms: Math.round(out.duration),
      ...(req.referer ? { referrer_domain: new URL(req.referer).hostname } : {}),
      ...(flags ? { flags } : {}),
    },
    derived: { ts: end, bot_class, browser, visitor_hash: visitorHash(req.ua, end) },
  });
  return items;
}

export function lifecycleItem(r: Rng, ts: number, kind: LifecycleEvent["kind"], region?: string, extra: Partial<LifecycleEvent> = {}): Item {
  return {
    event: { type: "lifecycle", event_id: uuid(r), client_ts: ts, kind, ...(region && kind === "boot" ? { region } : {}), ...extra },
    derived: { ts },
  };
}

export function metricItem(r: Rng, ts: number, name: MetricName, value: number): Item {
  return { event: { type: "metric", event_id: uuid(r), client_ts: ts, name, value: Math.round(value * 100) / 100 }, derived: { ts } };
}

export function blockItem(r: Rng, ts: number, route: string, count: number, total_ms: number, max_ms: number): Item {
  return { event: { type: "block", event_id: uuid(r), client_ts: ts, route, count, total_ms, max_ms }, derived: { ts } };
}

/** The wire batch for these events, as validateBatch checks it. */
export function wireBatch(release: string, items: readonly Item[]): Batch {
  return { schema_version: 1, sdk: SIM_SDK, release, environment: ENVIRONMENT, events: items.map((i) => i.event) };
}
