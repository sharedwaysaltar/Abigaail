import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIVE_FIELDS, toLiveEvent, toRow, type EventRow } from "@abigaail/store";
import type { AbigaailEvent } from "@abigaail/schema";

const ID = "00000000-0000-4000-8000-000000000001";
const PARENT = "00000000-0000-4000-8000-000000000002";
const derived = { ts: 5_000, visitor_hash: "f".repeat(32), browser: "chrome", bot_class: "human" };

const events: AbigaailEvent[] = [
  {
    type: "request", event_id: ID, client_ts: 1, method: "GET", route: "/user/[id]", status: 200, duration_ms: 3,
    req_bytes: 10, res_bytes: 20, sample_rate: 0.5, referrer_domain: "ref.example", flags: ["scanner_path"],
    transient: { ip: "203.0.113.9", ua: "Mozilla/5.0 marker-ua" },
  },
  { type: "outbound", event_id: ID, client_ts: 1, host: "api.example.com", method: "POST", status: 503, duration_ms: 9, outcome: "ok", parent_id: PARENT },
  { type: "error", event_id: ID, client_ts: 1, error_type: "TypeError", route: "/x", handled: true, frames: [{ file: "src/a.ts", line: 1 }], parent_id: PARENT },
  { type: "metric", event_id: ID, client_ts: 1, name: "cpu_percent", value: 12 },
  { type: "lifecycle", event_id: ID, client_ts: 1, kind: "boot", region: "LON1" },
];

describe("toLiveEvent", () => {
  it("gives exactly the allowlisted keys for each type, and none of the rest of the row", () => {
    for (const e of events) {
      const live = toLiveEvent(toRow(e, derived), "rel-1")!;
      expect(live.type).toBe(e.type);
      const allowed = LIVE_FIELDS[live.type];
      expect(Object.keys(live).every((k) => allowed.includes(k)), e.type).toBe(true);
      const text = JSON.stringify(live);
      for (const leak of [ID, PARENT, "f".repeat(32), "chrome", "ref.example", "src/a.ts", "LON1", "203.0.113.9", "marker-ua", "0.5"]) {
        expect(text, `${e.type} leaks ${leak}`).not.toContain(leak);
      }
    }
  });

  it("keeps what the Live view shows", () => {
    const [req, out, err, metric, boot] = events.map((e) => toLiveEvent(toRow(e, derived), "rel-1"));
    expect(req).toEqual({ type: "request", ts: 5_000, release: "rel-1", method: "GET", route: "/user/[id]", status: 200, duration_ms: 3, bot_class: "human", flags: ["scanner_path"] });
    expect(out).toEqual({ type: "outbound", ts: 5_000, release: "rel-1", host: "api.example.com", method: "POST", status: 503, duration_ms: 9, outcome: "ok" });
    expect(err).toEqual({ type: "error", ts: 5_000, release: "rel-1", error_type: "TypeError", route: "/x", handled: true });
    expect(metric).toEqual({ type: "metric", ts: 5_000, release: "rel-1", name: "cpu_percent", value: 12 });
    expect(boot).toEqual({ type: "lifecycle", ts: 5_000, release: "rel-1", kind: "boot" });
  });

  it("ignores unknown types and broken attrs", () => {
    const row = toRow(events[0]!, derived);
    expect(toLiveEvent({ ...row, type: "other" } as EventRow, "r")).toBeUndefined();
    expect(toLiveEvent({ ...row, attrs: "{not json" }, "r")).not.toHaveProperty("flags");
  });
});

describe("every read of app data is scoped by app_id", () => {
  // Tables holding monitored-app data. Reading any of them needs `app_id = ?`.
  const APP_TABLES = ["events", "findings", "hourly_route_stats", "rollup_hours", "daily_uniques", "deploys", "ingest_rejections"];
  const src = readFileSync(fileURLToPath(new URL("../src/reader.ts", import.meta.url)), "utf8");
  const sql = [...src.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2] ?? "").filter((q) => /\b(FROM|JOIN)\s+\w+/i.test(q));

  it("finds the queries", () => {
    expect(sql.length).toBeGreaterThan(25);
  });

  it.each(sql.map((q) => [q.replace(/\s+/g, " ").trim().slice(0, 90), q]))("%s", (_label, q) => {
    const tables = [...q.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1]!);
    if (!tables.some((t) => APP_TABLES.includes(t))) return;
    // Findings about Abigaail itself are the one exception (DECISIONS #44).
    if (/FROM findings WHERE app_id IS NULL/.test(q)) return;
    expect(q).toMatch(/\bapp_id = \?/);
  });
});
