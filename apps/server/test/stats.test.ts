import { describe, expect, it } from "vitest";
import { humanDuration, mad, median, poissonCdf, poissonUpperTail, wilsonLower } from "@abigaail/server";

describe("stats", () => {
  it("median and MAD ignore one outlier", () => {
    expect(median([])).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mad([10, 11, 9, 10, 500])).toBe(1);
  });

  it("Wilson lower bound stays low on little evidence", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    // 1 of 2 failing is "50%", but the bound is far lower.
    expect(wilsonLower(1, 2)).toBeLessThan(0.1);
    expect(wilsonLower(50, 100)).toBeCloseTo(0.404, 2);
    expect(wilsonLower(5, 1000)).toBeLessThan(0.005);
  });

  it("Poisson tails", () => {
    expect(poissonCdf(0, 2)).toBeCloseTo(Math.exp(-2), 10);
    expect(poissonCdf(2, 2)).toBeCloseTo(Math.exp(-2) * (1 + 2 + 2), 10);
    expect(poissonUpperTail(0, 3)).toBe(1);
    expect(poissonUpperTail(1, 3)).toBeCloseTo(1 - Math.exp(-3), 10);
    // Large expected counts do not underflow to 0.
    expect(poissonCdf(1000, 1000)).toBeGreaterThan(0.5);
    expect(poissonCdf(900, 1000)).toBeLessThan(0.001);
    expect(poissonCdf(900, 1000)).toBeGreaterThan(0);
  });

  it("formats durations", () => {
    expect(humanDuration(45_000)).toBe("45 s");
    expect(humanDuration(180_000)).toBe("3 min");
    expect(humanDuration(125 * 60_000)).toBe("2 h 5 min");
  });
});
