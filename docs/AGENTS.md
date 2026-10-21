# Agent design

How Abigaail's agents think. Every chunk that builds or changes an agent plans
against this document, not against generic thresholds. Requirements are in
[SPEC.md](SPEC.md); decisions in [DECISIONS.md](DECISIONS.md).

## Principles (apply to every agent)

A shallow agent applies one fixed threshold to every app ("error rate > 5% =
red"). That fails where monitoring matters: on low traffic (1 failure in 2
requests is 50%), across routes with different normals (an AI chat route at
8 s is fine; a profile page at 400 ms is not), and it explains nothing. So:

1. **Compare against the app's own normal, per route.** Normal = the same route
   at the same hour of the week over recent weeks (median and spread, e.g. MAD).
   Rules and arithmetic only, no ML.
2. **Count only traffic that matters.** Human requests (by `bot_class`),
   weighted by `1 / sample_rate`. Bots and flagged scanner probes are reported
   separately and never mixed into health.
3. **Require enough evidence.** A finding needs a minimum number of affected
   requests *and* a statistical bound (e.g. a Wilson lower bound for rates), so
   low-traffic staging does not flap.
4. **Find a cause, not just a symptom.** Line findings up by route, outbound
   host, release and time. Agents never call each other; they read the store
   (including other agents' findings) and write findings to it.
5. **Admit uncertainty.** "Unknown" (grey) is a real status. With no traffic or
   incomplete telemetry an agent says so instead of showing green.
6. **Every finding is actionable.** Severity, plain-English summary, evidence
   (numbers, windows, baseline), likely cause, suggested action, and a
   fingerprint (agent + signal + route/host/release) used for dedup and cooldowns.

## Health (agent 2)

Runs every minute over 1, 5 and 15-minute windows against the baseline. Uses
only request, error, outbound, metric and lifecycle events.

| # | Signal | Computation | Why it is not shallow |
|---|---|---|---|
| 1 | Is it running? | Heartbeats arriving; time since last `boot` | A `boot` with no `shutdown` before it means a crash or restart, even if the app is back up |
| 2 | Server errors | 5xx rate per route, human traffic, sample-weighted | Lower confidence bound and at least 5 failures; 4xx tracked separately (a 401 spike is a login problem, not an outage) |
| 3 | Latency | p50/p95/p99 per route vs that route's normal | Ratio (e.g. 2.5×) *and* an absolute floor, so 2 ms → 6 ms is not an alert |
| 4 | Saturation | Event-loop lag p99, CPU, memory vs normal, sustained | Event-loop lag is the Node-specific signal; spikes are linked to the slowest routes in the same minute, because one blocked route freezes all of them |
| 5 | Dependencies | Error/timeout/latency per outbound host | Names the cause: "Stripe is timing out, so `/api/checkout` fails", not two alerts |
| 6 | Traffic collapse | Request rate vs normal while heartbeats are fine | "Up but nobody gets through": proxy, DNS or TLS broken. A heartbeat alone misses it |
| 7 | New error bursts | Error types never seen before, or far above normal | First sign of a bad code path |
| 8 | Data trust | SDK drops, sampling, breaker backing off | Incomplete telemetry cannot be green: "amber: data incomplete" |

**Status per app:** red if any critical signal holds for 2 consecutive runs,
amber for a warning, grey for too little data, otherwise green. Recovery needs
3 good runs in a row (no flapping).

**Example finding:** 🔴 `/api/chat` p95 is 14.2 s, 3.1× its usual 4.6 s for
Tuesday 14:00, since 14:05; 212 human requests affected. At the same time
`api.anthropic.com` p95 rose from 3.9 s to 12.8 s. Likely cause: the upstream AI
provider. Suggested action: check the provider's status page; consider a
shorter timeout with a fallback message.

## Other agents

| Agent | Typical tools | Abigaail's deeper check |
|---|---|---|
| 1 Usage | Page views, top pages | Daily unique humans (the daily salt makes cross-day uniques impossible by design; the dashboard says so). Hour-of-week seasonality. Routes going quiet. Referrer spikes. Adoption of new routes after each release |
| 3 Watchdog | "No data for X minutes" | Learns each app's rhythm. Separates: process dead (no heartbeats); app alive but key revoked or rate-limited (ingest's 401/403/429 per key); no human traffic while heartbeats continue (Health); agent stalled or slowing. Watches Abigaail itself: DB growth, salt rotation failures, failed alert delivery. An external check watches the Watchdog |
| 4 Resilience | Memory graph | Leak = rising floor (each post-GC low point higher than the last). Restart loops (N boots without shutdown in M minutes). Which route blocks the event loop. Cold-start cost |
| 5 Rollout Safety | Totals before/after deploy | Same routes, same hours, before vs after, with a significance test. New error types, routes newly returning 404, crash loops after deploy (often a failed migration). "Recommend rollback" only with high impact and high confidence |
| 6 Privacy Auditor | Rare | Scans stored values for emails, IPs, tokens, JWTs, phone numbers, IBANs, name-like route segments. Re-scrubs stored error messages with today's rules: only a value that changes is a finding (re-scrubbed in place, counted, never shown); an older scrub version alone is not (DECISIONS #107). Verifies retention ran, `salt.bin` ≤ 1 day old, no transient fields stored. Re-identification risk: a country + city + browser combination matching one visitor is suppressed in the dashboard |
| 7 Outbound Dependencies | Latency per host | Per-host normals. First-seen host (compromise or exfiltration signal). Retry storms. N+1 calls per inbound request |
| 8 Config & Secrets | Usually none | Read-only external probes: `/.env`, `/.git/HEAD`, source maps, stack traces in 500 pages, `x-powered-by`. Staging pointing at production, detected from outbound hosts |
| 9 Edge & Trust | TLS expiry | Certificate expiry and chain. Security headers that disappeared after a deploy (HSTS, CSP). CORS wildcard with credentials. Cookies without `Secure`/`HttpOnly` (names only). Indexable staging. DNS record changes |
| 10 Bots & Abuse | Bot percentage | Credential stuffing (failures across many visitors) vs brute force (many failures, one visitor). Enumeration (one visitor, hundreds of `/user/[id]` hits, high 404 share). Missing rate limit (hundreds of login failures a minute, never a 429). Bandwidth served to AI crawlers |
| 11 Security | Scanner hit counts | Injection-like request answered 200, or worse 500 = input reached code: likely vulnerability. Scanner campaigns over time. First-seen outbound host shortly after injection attempts |
| 12 Geo | Country map | Country-mix changes. Admin routes from unexpected countries. Staging traffic from outside the owner's country |
| 13 Supply Chain | CVE lists | Lockfile diff per deploy. New `postinstall` scripts. Typosquat-like names. Maintainer changes. Unmaintained packages |
| 14 Cost & Capacity | Request counts | AI token spend per route and per visitor, month-end projection, cost per deploy ("this release doubled spend on `/api/chat`") |
| 15 Frontend Experience | Web Vitals | Vitals per route and browser. Hydration mismatches. CSP violations. Bundle growth per release. New third-party scripts |
| 16 Digest | A list of alerts | Organised by what changed, ranked by impact, including what resolved itself. Confirms quiet days: "nothing needs you today" |

## Data gaps (planned, not faked)

| Gap | Needed by | When |
|---|---|---|
| Link outbound calls to the inbound request that caused them (async context in the Node adapter) | Outbound (N+1), Health (cause) | Chunk 4 |
| Database query timing and pool use (driver hooks) | Outbound Dependencies | Phase 2 |
| AI token usage event per route | Cost & Capacity | Phase 4 |
| Expected env var names, present/missing (names only, never values) | Config & Secrets | Phase 3 |
| Deploy metadata (e.g. lockfile hash from the deploy step) | Supply Chain, Rollout Safety | Phase 2 / 4 |
| Read-only external prober (never changes the app) | Config & Secrets, Edge & Trust | Phase 3 |
| Geo lookup; browser adapter | Geo; Frontend Experience | Phase 3; Phase 5 |
