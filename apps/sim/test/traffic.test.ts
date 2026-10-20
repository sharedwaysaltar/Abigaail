// What the simulator sends: the right classes, nothing personal, and a burst
// that stays well inside ingest's and the SDK's limits.

import { describe, expect, it } from "vitest";
import { IPV4_RE, IPV6_RE } from "@abigaail/schema";
import { classifyUserAgent } from "@abigaail/server";
import { BOT_UAS, BOTS_BURST, DAY, generate, HOUR, humanUa, rng, sizing, SIM_TOKEN, VISITORS, type AppKind } from "@abigaail/sim";

const EMAIL = /[^\s/@]+@[^\s/@]+\.[a-z]{2,}/i;
// An IPv4 or IPv6 literal anywhere in a string (not only a whole string).
const IP_ANYWHERE = /\b(\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b/i;

describe("user agents", () => {
  it("every simulated browser is classified human, with a browser family", () => {
    for (let n = 0; n < VISITORS * 2; n++) {
      const ua = humanUa(n);
      expect(ua).toContain(SIM_TOKEN);
      expect(classifyUserAgent(ua)).toMatchObject({ bot_class: "human" });
      expect(classifyUserAgent(ua).browser).toMatch(/^(chrome|firefox)$/);
    }
  });

  it("every bot user agent gets the class it stands for", () => {
    for (const [kind, uas] of Object.entries(BOT_UAS)) for (const ua of uas) expect(classifyUserAgent(ua).bot_class).toBe(kind);
  });
});

describe("generated traffic", () => {
  for (const app of ["node", "next"] as AppKind[]) {
    it(`demo-${app}: a week of hours, bursts included, carries nothing personal`, () => {
      const r = rng(3);
      const start = Date.UTC(2026, 9, 19, 14);
      // A busy hour with the bots burst and every extra path, on each day of a week.
      const reqs = Array.from({ length: 7 }, (_, d) =>
        generate(r, app, start + d * DAY, start + d * DAY + HOUR, { humans: true, bots: BOTS_BURST, extra: [{ path: "/api/boom", perMin: 15 }] }),
      ).flat();
      expect(reqs.length).toBeGreaterThan(10_000);
      const bad: string[] = [];
      for (const q of reqs) {
        for (const value of [q.path, q.ua, q.referer ?? ""]) {
          if (EMAIL.test(value) || IP_ANYWHERE.test(value) || IPV4_RE.test(value) || IPV6_RE.test(value)) bad.push(value);
        }
        // Paths are fixed route names, numeric ids, or fixed probe strings.
        if (!/^\/([a-z.\-/]*|user\/\d+|api\/(slow|boom))$/i.test(q.path.split("?")[0]!)) bad.push(q.path);
        if (q.referer && !new URL(q.referer).hostname.endsWith(".example")) bad.push(q.referer);
      }
      expect([...new Set(bad)]).toEqual([]);
    }, 60_000);
  }
});

describe("bots burst sizing", () => {
  it("peak load stays far below the SDK's sampling point and ingest's per-app rate limit", () => {
    const s = sizing();
    // No sampling, no drops, no 429s: at least 10× headroom on each.
    expect(s.samplingMargin).toBeGreaterThan(10);
    expect(s.rateMargin).toBeGreaterThan(10);
  });
});
