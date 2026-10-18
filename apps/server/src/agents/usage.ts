// Usage (agent 1): how the app is used and what changed, against its own
// hour-of-week normal. Reads completed hours from the rollup only, never raw
// events. Every finding is info (never changes status) and a fact about the
// last completed hour or day, so it resolves as soon as it stops being true.

import { HOUR_MS, type App, type StatRow } from "@abigaail/store";
import { baselineSlots, mad, median, poissonCdf, poissonUpperTail, rowsByKey, totals, typicalCount } from "@abigaail/insights";
import { SCHEDULE, USAGE as U } from "./thresholds.js";
import type { Agent, AgentContext, AgentFinding } from "./types.js";

const DAY_MS = 24 * HOUR_MS;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const hourLabel = (t: number) => `${new Date(t).toISOString().slice(0, 13).replace("T", " ")}:00 UTC`;

function uniques(ctx: AgentContext, app: App): AgentFinding[] {
  const yesterday = Math.floor(ctx.windowEnd / DAY_MS) * DAY_MS - DAY_MS;
  const before = [1, 2, 3, 4].map((k) => day(yesterday - k * 7 * DAY_MS));
  const counts = ctx.store.dailyUniques(app.id, [day(yesterday), ...before]);
  const y = counts.get(day(yesterday));
  const usual = median(before.map((d) => counts.get(d) ?? 0).filter((n) => n > 0));
  if (y === undefined || usual === undefined || before.filter((d) => (counts.get(d) ?? 0) > 0).length < 2) return [];
  const change = (y - usual) / usual;
  if (Math.abs(change) < U.uniquesChange || Math.abs(y - usual) < U.uniquesMinAbs) return [];
  const weekday = new Date(yesterday).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return [{
    signal: "unique_humans",
    subject: "",
    severity: "info",
    summary: `${y} unique humans visited ${app.name} yesterday (${day(yesterday)}), ${change > 0 ? "up" : "down"} ${Math.round(Math.abs(change) * 100)}% from the usual ${Math.round(usual)} on a ${weekday}.`,
    action: change > 0 ? "Check referrers for where the visitors came from." : "Check for routes gone quiet or a broken entry page.",
    evidence: {
      day: day(yesterday),
      unique_humans: y,
      usual,
      compared_days: before,
      note: "Unique per UTC day: the daily salt makes counting the same visitor across days impossible by design.",
    },
    fact: true,
  }];
}

function quietRoutes(ctx: AgentContext, app: App, hour: number, last: Map<string, StatRow>): AgentFinding[] {
  const slots = baselineSlots(ctx.store, app.id, hour);
  if (slots.source === "none") return [];
  const out: AgentFinding[] = [];
  for (const [route, rows] of rowsByKey(ctx.store, app.id, "route", slots)) {
    const expected = typicalCount(rows);
    if (expected < U.quietMinExpected || last.has(route) || poissonCdf(0, expected) >= U.quietP) continue;
    out.push({
      signal: "route_quiet",
      subject: route,
      severity: "info",
      summary: `${route} got no human requests in the hour from ${hourLabel(hour)}; it usually gets about ${Math.round(expected)}.`,
      action: "Check that the page is still linked and reachable, and whether a deploy removed or renamed it.",
      evidence: { route, hour, expected, baseline: slots.source },
      fact: true,
    });
  }
  return out;
}

function referrers(ctx: AgentContext, app: App, hour: number): AgentFinding[] {
  const rows = ctx.store.hourly(app.id, "referrer", [hour]);
  if (!rows.length) return [];
  const seen = ctx.store.hourlyKeys(app.id, "referrer", hour - U.referrerHistoryMs, hour);
  const slots = baselineSlots(ctx.store, app.id, hour);
  const base = slots.source === "none" ? new Map() : rowsByKey(ctx.store, app.id, "referrer", slots);
  const out: AgentFinding[] = [];
  for (const r of rows) {
    if (!seen.has(r.key)) {
      if (r.uniques < U.referrerMin) continue;
      out.push({
        signal: "new_referrer",
        subject: r.key,
        severity: "info",
        summary: `New referrer: ${r.key} sent ${r.uniques} visitors (${r.n} requests) to ${app.name} in the hour from ${hourLabel(hour)}; not seen in the last 7 days.`,
        action: "Worth a look: a mention, a link from a new site, or referrer spam.",
        evidence: { referrer: r.key, hour, visitors: r.uniques, requests: r.n },
        fact: true,
      });
      continue;
    }
    if (slots.source === "none") continue;
    const expected = typicalCount(base.get(r.key));
    if (r.n < U.referrerMin || r.n < U.referrerFactor * Math.max(expected, 1)) continue;
    if (poissonUpperTail(r.n, Math.max(expected, 0.5)) >= U.referrerP) continue;
    out.push({
      signal: "referrer_spike",
      subject: r.key,
      severity: "info",
      summary: `${r.key} sent ${r.n} requests (${r.uniques} visitors) in the hour from ${hourLabel(hour)}, about ${Math.round(expected)} usually.`,
      action: "Check where the link appeared; make sure the landing route holds up.",
      evidence: { referrer: r.key, hour, requests: r.n, visitors: r.uniques, expected, baseline: slots.source },
      fact: true,
    });
  }
  return out;
}

function releaseAdoption(ctx: AgentContext, app: App, closedEnd: number): AgentFinding[] {
  const recent = ctx.store.deploys(app.id).filter((d) => d.first_seen >= ctx.windowEnd - U.releaseWindowMs);
  const latest = recent.sort((a, b) => b.first_seen - a.first_seen)[0];
  if (!latest) return [];
  const releaseHour = Math.floor(latest.first_seen / HOUR_MS) * HOUR_MS;
  // With no traffic before the release, every route would look new.
  if (ctx.store.hourlyKeys(app.id, "route", 0, releaseHour).size === 0) return [];
  const fresh = ctx.store.firstSeenSince(app.id, "route", releaseHour);
  if (!fresh.size) return [];
  const sums = new Map<string, { requests: number; visitors: number }>();
  for (const r of ctx.store.hourlyRange(app.id, "route", releaseHour, closedEnd)) {
    if (!fresh.has(r.key)) continue;
    const s = sums.get(r.key) ?? { requests: 0, visitors: 0 };
    s.requests += r.n;
    s.visitors += r.uniques;
    sums.set(r.key, s);
  }
  const routes = [...sums.entries()].sort((a, b) => b[1].requests - a[1].requests);
  return [{
    signal: "release_adoption",
    subject: latest.release,
    severity: "info",
    summary: `Release ${latest.release} added ${routes.length} new route${routes.length === 1 ? "" : "s"}: ` +
      routes.slice(0, 5).map(([route, s]) => `${route} (${s.requests} human requests)`).join(", ") + ".",
    action: "Compare with what the release was meant to ship; a new route nobody reaches may be unlinked.",
    evidence: {
      release: latest.release,
      first_seen: latest.first_seen,
      routes: routes.map(([route, s]) => ({ route, requests: s.requests, visitor_hours: s.visitors })),
    },
    fact: true,
  }];
}

function trafficPeak(ctx: AgentContext, app: App, hour: number, last: Map<string, StatRow>): AgentFinding[] {
  const slots = baselineSlots(ctx.store, app.id, hour);
  if (slots.source === "none") return [];
  const usualSeries = totals(ctx.store, app.id, "route", slots).map((t) => t.weighted_n);
  const usual = median(usualSeries) ?? 0;
  const spread = mad(usualSeries) ?? 0;
  const observed = [...last.values()].reduce((s, r) => s + r.weighted_n, 0);
  if (observed < U.peakMin || observed < U.peakFactor * usual || observed <= usual + U.peakMads * spread) return [];
  const top = [...last.values()].sort((a, b) => b.weighted_n - a.weighted_n).slice(0, 3);
  return [{
    signal: "traffic_peak",
    subject: "",
    severity: "info",
    summary: `Traffic peak: ${Math.round(observed)} human requests in the hour from ${hourLabel(hour)}, ${(observed / Math.max(usual, 1)).toFixed(1)}× the usual ${Math.round(usual)}. Top routes: ${top.map((r) => r.key).join(", ")}.`,
    action: "Check referrers for the source; watch Health for latency as load rises.",
    evidence: { hour, requests: observed, usual, spread, baseline: slots.source, top_routes: top.map((r) => ({ route: r.key, requests: r.weighted_n })) },
    fact: true,
  }];
}

function forApp(ctx: AgentContext, app: App): AgentFinding[] {
  if (app.disabled_at !== null) return [];
  const closedEnd = Math.floor(ctx.windowEnd / HOUR_MS) * HOUR_MS;
  const hour = closedEnd - HOUR_MS;
  // Judge only a completed, rolled-up hour in which the app sent something;
  // a silent app is the Watchdog's finding.
  if ((ctx.store.rolledHours(app.id, [hour]).get(hour) ?? 0) === 0) return uniques(ctx, app);
  const last = new Map(ctx.store.hourly(app.id, "route", [hour]).map((r) => [r.key, r]));
  return [
    ...uniques(ctx, app),
    ...quietRoutes(ctx, app, hour, last),
    ...referrers(ctx, app, hour),
    ...releaseAdoption(ctx, app, closedEnd),
    ...trafficPeak(ctx, app, hour, last),
  ];
}

export const usage: Agent = {
  name: "usage",
  ...SCHEDULE.usage,
  forApp,
};
