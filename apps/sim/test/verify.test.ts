// The tracker judges a finding by what it said when it was confirmed, not by
// how its summary reads later while it recovers.

import { describe, expect, it } from "vitest";
import type { Finding, Severity } from "@abigaail/store";
import { scenario, timeline, Tracker } from "@abigaail/sim";

const MIN = 60_000;
const START = Date.UTC(2026, 9, 21, 14, 0);

function finding(at: number, severity: Severity, summary: string, state: "open" | "resolved" = "open", critical_streak = severity === "critical" ? 2 : 0): Finding {
  return {
    id: 1, app_id: "app", agent: "health", fingerprint: "health:dependency:localhost", signal: "dependency", severity, state,
    summary, cause: null, action: "", evidence: {}, hits: 1, misses: 0, critical_streak, resolves: "misses",
    first_seen: START + 8 * MIN, last_seen: at, resolved_at: state === "resolved" ? at : null, resolved_reason: null,
  };
}

describe("summary words", () => {
  // The dependency scenario starting 6 min into the run: fault 6-11 min.
  const t = () => timeline(START, [{ scenario: scenario("node", "dependency")!, at: 6 * MIN }]);

  it("pass when the confirmed summary had them, even if the summary changes during recovery", () => {
    const tr = new Tracker(t());
    tr.observe([finding(START + 8 * MIN, "critical", "localhost is failing: 12 of 12 calls in 5 min ended in an error, timeout or 5xx, so /checkout fails.")]);
    // Recovery: the route no longer fails enough to fold, so the words are gone.
    tr.observe([finding(START + 14 * MIN, "warning", "localhost is failing: 13 of 48 calls in 5 min ended in an error, timeout or 5xx.")]);
    tr.observe([finding(START + 20 * MIN, "warning", "localhost is failing: 13 of 48 calls in 5 min ended in an error, timeout or 5xx.", "resolved")]);
    const [r] = tr.results(START + 21 * MIN);
    expect(r).toMatchObject({ status: "pass", showMs: 2 * MIN, resolveMs: 9 * MIN });
  });

  it("fail when no summary since confirmation had them, quoting the confirmed one", () => {
    const tr = new Tracker(t());
    tr.observe([finding(START + 8 * MIN, "critical", "localhost is failing: 12 of 12 calls in 5 min ended in an error, timeout or 5xx.")]);
    tr.observe([finding(START + 20 * MIN, "critical", "localhost is failing: 12 of 12 calls in 5 min ended in an error, timeout or 5xx.", "resolved")]);
    const [r] = tr.results(START + 21 * MIN);
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain('lacks "localhost is failing", "so /checkout fails"; when confirmed it read: localhost is failing: 12 of 12');
  });

  it("an earlier, weaker emission does not count: only what was said at or after confirmation", () => {
    const tr = new Tracker(t());
    tr.observe([finding(START + 7 * MIN, "warning", "localhost is failing: 3 of 9 calls …, so /checkout fails.")]);
    tr.observe([finding(START + 8 * MIN, "critical", "localhost is failing: 12 of 12 calls in 5 min.")]);
    tr.observe([finding(START + 20 * MIN, "critical", "localhost is failing: 12 of 12 calls in 5 min.", "resolved")]);
    expect(tr.results(START + 21 * MIN)[0]!.status).toBe("fail");
  });

  it("a critical counts only once confirmed red (2 runs in a row at critical)", () => {
    const tr = new Tracker(t());
    tr.observe([finding(START + 7 * MIN, "critical", "localhost is failing: 12 of 12 calls in 5 min, so /checkout fails.", "open", 1)]);
    expect(tr.results(START + 7 * MIN)[0]!.status).toBe("waiting");
    tr.observe([finding(START + 8 * MIN, "critical", "localhost is failing: 12 of 12 calls in 5 min, so /checkout fails.", "open", 2)]);
    expect(tr.results(START + 8 * MIN)[0]).toMatchObject({ status: "shown", showMs: 2 * MIN });
  });
});
