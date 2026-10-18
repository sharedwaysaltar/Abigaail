# Abigaail: project specification

The owner's brief. Treat this as the requirements source of truth; decisions
taken while building are logged in [DECISIONS.md](DECISIONS.md).

## Goal

A self-hosted system giving full technical visibility into any app the owner
deploys, with zero personal data. One dashboard is the single source of truth.
No third-party monitoring or analytics. First test subject: "The Well" (staging).
First ecosystem: JavaScript/TypeScript (Node, Next.js, React, Express/Fastify,
serverless/edge). The core must be framework-agnostic so other ecosystems (e.g.
JVM) can be added later through adapters.

## Hard requirements (lessons from 10 years of monitoring failures)

1. **Monitoring must never become the outage.** The SDK is fail-open: non-blocking,
   bounded in-memory queue, drop events on overflow, short timeouts, circuit breaker,
   sampling under load. If Abigaail is down, the app is unaffected.
2. **Silence is a finding.** A Watchdog agent alerts when an app stops sending events
   (dead-man's switch) and when an agent stops running. Alert delivery (email/webhook)
   works even if the dashboard is down. Add one external uptime check.
3. **No personal data leaks.** ALLOWLIST scrubber: only named fields leave the app,
   everything else is dropped. Query-string values, bodies, headers, cookies and free
   text are never collected. The server re-validates and rejects forbidden fields.
   Tests must prove it.
4. **The platform is a high-value target.** Ingest keys are write-only and per app.
   Abigaail can never execute code or change anything in a monitored app: read-only by
   design. Dashboard needs strong auth (MFA), rate-limited ingest, secrets only in env,
   and audit logs of admin actions.
5. **No cardinality explosions.** Routes are normalised (/user/[id]), label values are
   capped, raw URLs are never stored as dimensions.
6. **No alert fatigue.** Findings are fingerprinted and deduplicated, grouped by cause,
   with cooldowns. Only critical findings notify. Each finding has severity,
   plain-English summary, evidence, suggested action.
7. **Storage growth is managed.** Raw events kept 30 days (configurable), then daily
   rollups; indexes on (app_id, timestamp). SQLite first, Postgres-ready. Automated
   backup with a tested restore.
8. **SDKs drift.** Event schema is versioned; server accepts N and N-1; events carry an
   idempotent event_id; the server sets the authoritative timestamp.
9. **Multi-tenant from day one.** Every query is scoped by app_id.
10. **Agents fail in isolation.** One crashing, slow or looping agent never affects
    others. Each has a timeout, is idempotent, and logs to agent_runs.
11. **"Is everything OK right now?" in 5 seconds.** One status per app
    (green/amber/red) at the top, detail underneath.

## Full visibility, no personal data

**Collect:**
- Every request in and out: method, normalised route, status, duration, size, deploy version
- Failures: error type, scrubbed stack traces, error rates, failed auth counts
- Realtime health: uptime, latency p50/p95/p99, error rate, memory, CPU, event-loop lag, restarts
- Deploy health: before/after comparison per release
- Security signals: scanner paths, brute-force patterns, injection-like signatures
  (flagged, never stored), rate spikes, unexpected outbound hosts
- Dependencies: vulnerabilities, version drift, lockfile changes
- Pseudonymous traffic: rotating-salt hashed visitor ID, country/city, browser family,
  referrer domain

**Never collect:** raw IPs, emails, names, user IDs, cookies, tokens, auth headers,
request/response bodies, form inputs, query values, free-text user content.

**GDPR:** treat the hashed visitor ID as pseudonymous personal data. Geo lookup uses
the IP in memory at ingest, then discards it. No cookies. Retention policy, a deletion
path, and a short privacy-notice snippet. Never claim "anonymous".

## Multi-agent design

- Agents are small independent TypeScript workers with one contract: `run(ctx) -> Finding[]`.
- Agents never call each other. They read from the shared store and write findings to
  it (blackboard pattern). The dashboard reads only from the store.
- Each agent has its own schedule. A new agent = one file plus one registry line.
- Rules and thresholds only. No ML.

Agents, in build order:
1. Usage: traffic per route/time, peaks, top routes, unique visitors, trends
2. Health (realtime): live error rate, latency, uptime, resource signals, threshold alerts
3. Watchdog: silent apps, stalled agents, failed alert delivery
4. Resilience: memory growth/leaks, event-loop lag, unhandled rejections, restart loops, cold starts
5. Rollout Safety: compares each release to the previous; raises "recommend rollback"
6. Privacy Auditor: scans stored data for emails, IPs, tokens, ID-like strings; verifies retention ran
7. Outbound Dependencies: per-host latency/timeouts/errors, slow queries, pool exhaustion, N+1, first-seen host
8. Config & Secrets: missing env vars, debug mode, staging pointing at prod, exposed /.env /.git, leaked keys (flag only)
9. Edge & Trust: TLS expiry, DNS changes, multi-region uptime, security headers, cookie flags, staging noindexed
10. Bots & Abuse: human vs crawler vs AI crawler vs automation, credential stuffing, enumeration, missing rate limits
11. Security: scanner paths, brute force, bursts, suspicious outbound calls
12. Geo: country/city at ingest, IP discarded immediately
13. Supply Chain: lockfile diffs per deploy, postinstall scripts, typosquats, unmaintained packages, CVEs
14. Cost & Capacity: requests, bandwidth, invocations, AI token spend per route; trends and spikes
15. Frontend Experience: Core Web Vitals, JS errors by browser, hydration mismatches, bundle size, CSP violations
16. Digest: plain-English daily summary of what changed and what needs attention

## Architecture (keep it small)

- Collectors: `@abigaail/core` plus thin adapters (Node, Next.js, browser, serverless/edge).
- Ingest: POST /ingest, per-app key, zod validation, append-only, batched.
- Storage: one database. Tables: apps, events, findings, agent_runs, deploys.
- Realtime: Server-Sent Events from ingest to dashboard. No websockets, no message queues.
- Dashboard (Next.js, login + MFA, app switcher): Status, Live, Usage, Security, Deploys,
  Agents, Digest. Four lenses: Usage, Health, Security, Compliance & Cost.

## Phases (build one, stop, owner tests)

1. Schema, core SDK (fail-open), Next.js adapter, ingest, SQLite, Status/Live/Usage views,
   agents 1-3. Wire into The Well staging.
2. Allowlist scrubber + privacy tests, agents 4-7.
3. Agents 8-12, findings feed with dedup and cooldowns, email/webhook alerts.
4. Agents 13-16, retention/rollups, backups, multi-app support.
5. Packaging so a new app connects in under 10 minutes, Node/Express and browser
   adapters, then evaluate a JVM adapter on the same schema.

## Working instructions

- Minimal dependencies, each justified. No Kafka, microservices, Kubernetes or ML.
- Tests required for: scrubber/allowlist, ingest validation, hashing, dedup, SDK fail-open.
- A script that simulates bad traffic (scanner paths, failed logins, error bursts) to
  verify agents on low-traffic staging.
- README: setup, connecting a new app, privacy notice snippet.
