// Alerts carry nothing on the never-collect list (DECISIONS #97). Every
// finding the real agents raise over the whole `run all` plan is rendered as
// an alert in every format, and none of them contains a visitor hash, a user
// agent, an IP address, a concrete user id, a query value, a referrer path,
// an email address, a token or an ingest key. A planted finding shows the
// scanner would catch one.

import { afterAll, describe, expect, it } from "vitest";
import { findingLink, itemFrom, subject, text, webhookRequest, WEBHOOK_FORMATS, type AlertMessage } from "@abigaail/server";
import type { Finding } from "@abigaail/store";
import { BOT_UAS, INJECTION_PATHS, plan, REFERRERS, replay, SIM_TOKEN, type AppKind } from "@abigaail/sim";
import { cleanup, QUIET, seededStore } from "./simfx.js";

afterAll(cleanup);

const PATTERNS: [string, RegExp][] = [
  ["IPv4 address", /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
  ["IPv6 address", /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/i],
  ["email address", /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ["concrete user id", /\/user\/\d+/],
  ["query string", /\?[a-z_]+=/i],
  ["JWT", /eyJ[\w-]{8,}\./],
  ["ingest key", /abk_/],
  ["bearer token", /bearer\s/i],
  ["browser user agent", /Mozilla\/5\.0/],
];

function forbidden(app: AppKind, visitorHashes: readonly string[]): string[] {
  return [
    SIM_TOKEN,
    ...Object.values(BOT_UAS).flat(),
    ...INJECTION_PATHS[app],
    ...INJECTION_PATHS[app].map((p) => decodeURIComponent(p.split("?")[1]!)),
    ...REFERRERS.map((r) => new URL(r)).filter((u) => u.pathname !== "/").map((u) => `${u.hostname}${u.pathname}`),
    ...visitorHashes,
  ];
}

/** Every rendering of one finding as an alert: firing and recovered, every format, the email subject and text. */
function renderings(f: Finding, appName: string): string[] {
  const out: string[] = [];
  for (const change of ["firing", "recovered"] as const) {
    // The dashboard link is Abigaail's own URL (checked below); the scan covers everything else.
    const link = findingLink(new URL("https://dash.example"), appName, f)!;
    expect(link).toMatch(/^https:\/\/dash\.example\/findings\?app=[a-z0-9-]+(&state=resolved)?#finding-\d+$/);
    const item = itemFrom(f, appName, change, { flaps: 1, link: null });
    const m: AlertMessage = { version: 1, delivery_id: "d", kind: "alert", created_at: f.last_seen, items: [item], more: 0 };
    out.push(JSON.stringify(m), subject(m), text(m));
    for (const format of WEBHOOK_FORMATS) {
      const r = webhookRequest(m, format, "s".repeat(32), f.last_seen);
      out.push(r.body, JSON.stringify(r.headers));
    }
  }
  return out;
}

function leaks(rendered: readonly string[], strings: readonly string[]): string[] {
  const found: string[] = [];
  for (const r of rendered) {
    for (const s of strings) if (r.includes(s)) found.push(`contains "${s.slice(0, 40)}"`);
    for (const [what, re] of PATTERNS) if (re.test(r)) found.push(`${what}: ${re.exec(r)![0]}`);
  }
  return [...new Set(found)];
}

describe("alerts carry no personal data", () => {
  for (const app of ["node", "next"] as const) {
    it(`every finding of \`run all\` on demo-${app}, rendered in every format`, () => {
      const s = seededStore(app, QUIET);
      try {
        replay({ store: s.store, appId: s.appId, app, plan: plan(app, ["all"]), start: QUIET });
        const findings = s.store.findingHistory(s.appId, 10_000);
        const system = s.store.systemFindings();
        // The run raises real criticals, so this is not vacuous.
        expect(findings.filter((f) => f.severity === "critical").length).toBeGreaterThan(0);
        const hashes = [...new Set(s.store.recentEvents(s.appId, 1_000_000).map((e) => e.visitor_hash).filter((h): h is string => !!h))];
        expect(hashes.length).toBeGreaterThan(100);
        const rendered = [...findings.flatMap((f) => renderings(f, `sim-${app}`)), ...system.flatMap((f) => renderings(f, "Abigaail"))];
        expect(leaks(rendered, forbidden(app, hashes))).toEqual([]);

        // Control: the scanner finds a planted value in a summary and in a cause.
        const planted: Finding = { ...findings[0]!, summary: `Login failed for owner@example.com from 203.0.113.7 via /user/42?id=7`, cause: `${hashes[0]} ${SIM_TOKEN}` };
        expect(leaks(renderings(planted, `sim-${app}`), forbidden(app, hashes)).length).toBeGreaterThanOrEqual(5);
      } finally {
        s.close();
      }
    }, 300_000);
  }
});
