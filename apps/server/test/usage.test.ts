import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { health, usage } from "@abigaail/server";
import { HOUR_MS } from "@abigaail/store";
import { Fx, signals, WEEK } from "./agentfx.js";

let fx: Fx;
beforeEach(() => {
  fx = new Fx();
});
afterEach(() => fx.close());

/** The last completed hour Usage judges: 13:00-14:00 UTC on Wednesday. */
const LAST = () => Math.floor((fx.now - 45_000) / HOUR_MS) * HOUR_MS - HOUR_MS;

/** Fill an hour with requests and roll it up. */
function hour(h: number, count: number, r: Parameters<Fx["requests"]>[3] = {}, release?: string): void {
  fx.requests(h, h + HOUR_MS, count, r, release);
  fx.store.rollupHour(fx.appId, h);
}

/** The same hour-of-week as LAST over the 4 previous weeks. */
function usualWeeks(fill: (h: number) => void): void {
  for (let k = 1; k <= 4; k++) {
    const h = LAST() - k * WEEK;
    fill(h);
    fx.store.rollupHour(fx.appId, h);
  }
}

describe("usage", () => {
  it("a route that usually gets traffic and got none is 'gone quiet'", () => {
    usualWeeks((h) => {
      fx.requests(h, h + HOUR_MS, 30, { route: "/" });
      fx.requests(h, h + HOUR_MS, 30, { route: "/pricing" });
    });
    hour(LAST(), 30, { route: "/" });
    const found = fx.run(usage);
    expect(signals(found)).toEqual(["route_quiet:/pricing:info"]);
    expect(found[0]!.summary).toBe("/pricing got no human requests in the hour from 2026-10-21 13:00 UTC; it usually gets about 30.");
  });

  it("without a baseline it stays quiet rather than guessing", () => {
    hour(LAST(), 30, { route: "/" });
    expect(fx.run(usage)).toEqual([]);
  });

  it("a new referrer with enough visitors is noted; a handful is not", () => {
    hour(LAST(), 40, (i) => ({ route: "/", visitor: `v${i}`, ...(i < 15 ? { referrer: "news.example" } : i < 20 ? { referrer: "tiny.example" } : {}) }));
    const found = fx.run(usage);
    expect(signals(found)).toEqual(["new_referrer:news.example:info"]);
    expect(found[0]!.evidence).toMatchObject({ visitors: 15, requests: 15 });
  });

  it("a known referrer far above its normal is a spike", () => {
    usualWeeks((h) => fx.requests(h, h + HOUR_MS, 30, (i) => ({ route: "/", ...(i < 2 ? { referrer: "blog.example" } : {}) })));
    hour(LAST() - 2 * HOUR_MS, 5, { referrer: "blog.example" });
    hour(LAST(), 60, (i) => ({ route: "/", visitor: `v${i}`, ...(i < 40 ? { referrer: "blog.example" } : {}) }));
    // Total traffic doubled too, so a traffic peak is reported alongside.
    expect(signals(fx.run(usage).filter((f) => f.signal.includes("referrer")))).toEqual(["referrer_spike:blog.example:info"]);
  });

  it("reports adoption of routes a new release added", () => {
    hour(LAST() - 5 * HOUR_MS, 20, { route: "/" }, "r1");
    hour(LAST(), 40, (i) => ({ route: i < 25 ? "/" : "/new-feature" }), "r2");
    const found = fx.run(usage);
    expect(signals(found)).toEqual(["release_adoption:r2:info"]);
    expect(found[0]!.summary).toBe("Release r2 added 1 new route: /new-feature (15 human requests).");
  });

  it("a traffic peak far above the hour's normal", () => {
    usualWeeks((h) => fx.requests(h, h + HOUR_MS, 100 + (h % 7), { route: "/" }));
    hour(LAST(), 400, (i) => ({ route: i % 2 ? "/" : "/launch" }));
    const [f] = fx.run(usage);
    expect(f).toMatchObject({ signal: "traffic_peak", severity: "info" });
    expect(f!.summary).toMatch(/^Traffic peak: 400 human requests in the hour from 2026-10-21 13:00 UTC, 4\.0× the usual 10\d\. Top routes: \/, \/launch\.$/);
  });

  it("compares yesterday's unique humans with the same weekday, and says why it is per day", () => {
    const yesterday = Math.floor(fx.now / (24 * HOUR_MS)) * 24 * HOUR_MS - 24 * HOUR_MS + 10 * HOUR_MS;
    for (let k = 1; k <= 4; k++) hour(yesterday - k * WEEK, 50, (i) => ({ visitor: `w${k}-${i}` }));
    hour(yesterday, 120, (i) => ({ visitor: `y${i}` }));
    const [f] = fx.run(usage).filter((x) => x.signal === "unique_humans");
    expect(f!.summary).toBe("120 unique humans visited app yesterday (2026-10-20), up 140% from the usual 50 on a Tuesday.");
    expect(String(f!.evidence.note)).toMatch(/daily salt/);
  });

  it("usage findings are info and never change the app's status", () => {
    hour(LAST(), 40, (i) => ({ route: "/", visitor: `v${i}`, ...(i < 15 ? { referrer: "news.example" } : {}) }));
    fx.requests(fx.now - 4 * 60_000, fx.now - 50_000, 40, { route: "/" });
    fx.runAndRecord(health);
    expect(fx.runAndRecord(usage)).toBe("green");
    expect(fx.store.openFindings(fx.appId).map((f) => f.severity)).toEqual(["info"]);
  });
});
