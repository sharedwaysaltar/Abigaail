// Rollout Safety's rules (DECISIONS #131-#133): the exact tests, each gate
// between "watch" and "recommend rollback", the 2-run hold, and the
// correction for repeated looks over 1,000 simulated days of an unchanged
// release.

import { describe, expect, it } from "vitest";
import { binomialUpperTail, heldVerdict, judge, logGamma, ROLLOUT as R, type JudgeInput, type RouteInput } from "@abigaail/insights";

const MIN = 60_000;

describe("exact tails", () => {
  it("log-gamma matches factorials", () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(11)).toBeCloseTo(Math.log(3628800), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
  });

  it("binomial upper tails match exact sums (computed with exact integer arithmetic)", () => {
    expect(binomialUpperTail(5, 50, 0.01)).toBeCloseTo(0.00014568926807182692, 15);
    expect(binomialUpperTail(3, 10, 0.5)).toBeCloseTo(0.9453125, 12);
    expect(binomialUpperTail(2, 100, 0.05)).toBeCloseTo(0.9629187906726409, 12);
    expect(binomialUpperTail(60, 1000, 0.05)).toBeCloseTo(0.08673217838485746, 10);
    expect(binomialUpperTail(30, 100, 0.05) / 8.556384800197262e-16).toBeCloseTo(1, 8);
    expect(binomialUpperTail(0, 10, 0.1)).toBe(1);
    expect(binomialUpperTail(11, 10, 0.1)).toBe(0);
  });
});

// ---- judge -------------------------------------------------------------------------

function route(r: Partial<RouteInput> & { route: string }): RouteInput {
  return { after: { n: 0, weighted: 0, x5: 0, x4: 0, x404: 0 }, ...r };
}

/** 40 min after a deploy: /checkout (15% of the traffic) and /other, usually 0.5% 5xx. */
function input(over: Partial<JudgeInput> = {}, checkout: Partial<RouteInput> = {}): JudgeInput {
  return {
    spanMs: 40 * MIN,
    appAfter: 1200,
    appBefore: { n: 50_000, x5: 250, x4: 500 },
    routes: [
      route({ route: "/checkout", after: { n: 180, weighted: 180, x5: 1, x4: 2, x404: 0 }, before: { n: 7500, weighted: 7500, x5: 37, x4: 75 }, expected: 180, usualShare: 0.15, ...checkout }),
      route({ route: "/other", after: { n: 1020, weighted: 1020, x5: 5, x4: 10, x404: 0 }, before: { n: 42_500, weighted: 42_500, x5: 213, x4: 425 }, expected: 1020, usualShare: 0.85 }),
    ],
    newErrors: [],
    collapse: false,
    looks: R.looks,
    ...over,
  };
}
const broken = { after: { n: 180, weighted: 180, x5: 72, x4: 2, x404: 0 } };

describe("verdicts", () => {
  it("a route that breaks after the deploy: recommend rollback, with impact and confidence measured", () => {
    const j = judge(input({}, broken));
    expect(j.raw).toBe("rollback");
    expect(j.impact).toMatchObject({ met: true, rule: "route_failing" });
    expect(j.confidence.met).toBe(true);
    expect(j.confidence.corrected!).toBeLessThan(R.alphaRollback);
    expect(j.covers.routes["/checkout"]).toEqual(["errors"]);
  });

  it("an unchanged release looks fine once there is enough evidence", () => {
    expect(judge(input()).raw).toBe("fine");
    expect(judge(input({ spanMs: 20 * MIN, appAfter: 150 })).raw).toBe("too_little");
  });

  it("evidence gate: 20 failures in 40 requests is too little traffic, not a rollback (a route needs 50)", () => {
    const j = judge(input({ appAfter: 40, routes: [route({ route: "/checkout", after: { n: 40, weighted: 40, x5: 20, x4: 0, x404: 0 }, before: { n: 7500, weighted: 7500, x5: 37, x4: 75 }, usualShare: 1 })] }));
    expect(j.raw).toBe("too_little");
    expect(j.signals.filter((s) => s.significant)).toEqual([]);
  });

  it("nothing but a crash loop is judged before minObservedMs", () => {
    expect(judge(input({ spanMs: R.minObservedMs - 1 }, broken)).raw).toBe("too_little");
    expect(judge(input({ spanMs: R.minObservedMs - 1, loop: { crashes: 4, text: "uncaught MigrationError", firstAt: 0 } })).raw).toBe("rollback");
  });

  it("the change must start at the deploy: a previous release already failing makes it watch", () => {
    const j = judge(input({ preDeployAnomaly: "/checkout 5xx on 40 of 90 requests" }, broken));
    expect(j.raw).toBe("watch");
    expect(j.confidence.why).toMatch(/already failing before the deploy/);
  });

  it("failures a failing dependency explains are Health's, never the release's", () => {
    const j = judge(input({}, { ...broken, dependency: { host: "api.stripe.com", requests: 70 } }));
    expect(j.raw).toBe("fine");
    expect(j.covers.routes).toEqual({});
  });

  it("impact below the bar is watch: a small route failing", () => {
    // /checkout carries 5% of the traffic: failing, significant, but no rollback-level impact (excess 3%).
    const j = judge(input({}, { ...broken, after: { n: 60, weighted: 60, x5: 24, x4: 0, x404: 0 }, usualShare: 0.05 }));
    expect(j.raw).toBe("watch");
    expect(j.impact.met).toBe(false);
  });

  it("confidence needs enough extra failures", () => {
    // 19 of 50: a big route failing for a quarter of its requests, but only about 19 extra failures yet.
    const j = judge(input({}, { after: { n: 50, weighted: 50, x5: 19, x4: 0, x404: 0 } }));
    expect(j.impact.met).toBe(true);
    expect(j.raw).toBe("watch");
    expect(j.confidence.why).toMatch(/extra failures so far/);
  });

  it("newly returning 404: 4xx other than 401/403 counts, with the 404s named", () => {
    const j = judge(input({}, { after: { n: 180, weighted: 180, x5: 0, x4: 90, x404: 88 } }));
    expect(j.raw).toBe("rollback");
    expect(j.signals.find((s) => s.kind === "client_errors")!.detail.not_found).toBe(88);
  });

  it("latency: slower than usual is watch; as slow as Health's critical on a big route is a rollback", () => {
    const lat = (p95: number, above: number) => input({}, { latency: { n: 200, above, p95, usual: 80 } });
    expect(judge(lat(100, 12)).raw).toBe("fine");
    const watch = judge(lat(190, 200));
    expect(watch.raw).toBe("watch");
    expect(watch.covers.routes["/checkout"]).toEqual(["latency"]);
    expect(judge(lat(400, 200)).raw).toBe("rollback");
  });

  it("a route that went quiet is a signal, unless Health sees a traffic collapse (proxy, not the release)", () => {
    const quiet = { after: { n: 0, weighted: 0, x5: 0, x4: 0, x404: 0 }, expected: 180 };
    expect(judge(input({}, quiet)).raw).toBe("rollback");
    expect(judge(input({ collapse: true }, quiet)).raw).not.toBe("rollback");
  });

  it("new error types are watch, and covered for Health's new_error", () => {
    const j = judge(input({ newErrors: [{ key: "TypeError /checkout", n: 4 }] }));
    expect(j.raw).toBe("watch");
    expect(j.covers.error_keys).toEqual(["TypeError /checkout"]);
    expect(judge(input({ newErrors: [{ key: "TypeError /checkout", n: 2 }] })).raw).toBe("fine");
  });
});

describe("2 runs in a row", () => {
  it("a verdict, or a change of verdict, is reported only once it held twice", () => {
    expect(heldVerdict("rollback", undefined)).toBe("too_little");
    expect(heldVerdict("rollback", { raw: "watch", reported: "watch" })).toBe("watch");
    expect(heldVerdict("rollback", { raw: "rollback", reported: "watch" })).toBe("rollback");
    // A single-run spike never shows.
    expect(heldVerdict("watch", { raw: "fine", reported: "fine" })).toBe("fine");
    expect(heldVerdict("fine", { raw: "watch", reported: "fine" })).toBe("fine");
  });
});

// ---- repeated looks ------------------------------------------------------------------

/** mulberry32: a seeded generator, so a failure prints a seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(r: () => number, lambda: number): number {
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(r)));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > l);
  return k - 1;
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}
function binomial(r: () => number, n: number, p: number): number {
  if (n > 50) return Math.min(n, Math.max(0, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * gauss(r))));
  let k = 0;
  for (let i = 0; i < n; i++) if (r() < p) k++;
  return k;
}

/**
 * One release over a day, looked at every minute: routes from 0.5 to 40
 * requests a minute, usual 5xx and 4xx shares from 0.2% to 5%, latency whose
 * p95 wanders ±25% (so the effect gate opens on some looks), nothing changed.
 */
function noisyDay(seed: number, looks: number): { watch: number; rollback: number } {
  const r = rng(seed);
  const profile = [
    { rate: 0.5, p5: 0.05, p4: 0.02 },
    { rate: 1, p5: 0.02, p4: 0.05 },
    { rate: 2, p5: 0.01, p4: 0.01 },
    { rate: 5, p5: 0.005, p4: 0.02 },
    { rate: 10, p5: 0.002, p4: 0.01 },
    { rate: 20, p5: 0.01, p4: 0.005 },
    { rate: 40, p5: 0.003, p4: 0.002 },
    { rate: 3, p5: 0.03, p4: 0.03 },
  ];
  const usual = 400;
  const total = profile.reduce((s, x) => s + x.rate, 0);
  const routes = profile.map((x, i) => {
    // Four weeks of the same hours: the pooled baseline, itself a sample.
    const n0 = Math.round(4 * 1440 * x.rate);
    return { ...x, name: `/r${i}`, before: { n: n0, weighted: n0, x5: binomial(r, n0, x.p5), x4: binomial(r, n0, x.p4) }, n: 0, x5: 0, x4: 0, recent: [] as number[] };
  });
  let watch = 0;
  let rollback = 0;
  for (let minute = 1; minute <= 1440; minute++) {
    for (const rt of routes) {
      const k = poisson(r, rt.rate);
      rt.n += k;
      rt.x5 += binomial(r, k, rt.p5);
      rt.x4 += binomial(r, k, rt.p4);
      rt.recent.push(k);
      if (rt.recent.length > 30) rt.recent.shift();
    }
    const appBefore = { n: routes.reduce((s, x) => s + x.before.n, 0), x5: routes.reduce((s, x) => s + x.before.x5, 0), x4: routes.reduce((s, x) => s + x.before.x4, 0) };
    const j = judge({
      spanMs: minute * MIN,
      appAfter: routes.reduce((s, x) => s + x.n, 0),
      appBefore,
      routes: routes.map((rt) => {
        const n = rt.recent.reduce((s, x) => s + x, 0);
        return {
          route: rt.name,
          after: { n: rt.n, weighted: rt.n, x5: rt.x5, x4: rt.x4, x404: 0 },
          before: rt.before,
          expected: rt.rate * minute,
          usualShare: rt.rate / total,
          ...(n ? { latency: { n, above: binomial(r, n, R.aboveUsualShare), p95: usual * Math.exp(0.25 * gauss(r)), usual } } : {}),
        };
      }),
      newErrors: [],
      collapse: false,
      looks,
    });
    if (j.raw === "watch") watch++;
    if (j.raw === "rollback") rollback++;
  }
  return { watch, rollback };
}

describe("repeated looks (#132)", () => {
  it("1,000 simulated days of a noisy, unchanged release: never watch, never rollback", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const { watch, rollback } = noisyDay(seed, R.looks);
      if (watch || rollback) throw new Error(`seed ${seed}: ${watch} watch and ${rollback} rollback looks on an unchanged release`);
    }
  }, 120_000);

  it("without the correction for looks, the same days raise false alarms (the protection is what passes the test above)", () => {
    let alarms = 0;
    for (let seed = 1; seed <= 200; seed++) alarms += noisyDay(seed, 1).watch;
    expect(alarms).toBeGreaterThan(0);
  }, 60_000);
});
