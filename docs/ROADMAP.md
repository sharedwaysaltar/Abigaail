# Roadmap

Everything runs on a laptop first (VS Code + browser). Hosting comes later.

## Phase 1, in chunks

| Chunk | Contents | How you test it |
|---|---|---|
| 1 ✅ | Monorepo, event schema v1, `@abigaail/core` fail-open SDK | `npm run check` |
| 2 ✅ | `@abigaail/store` (SQLite) + ingest server | `npm run dev:server`, curl a batch |
| 3 ✅ | `@abigaail/node` + `@abigaail/next` adapters, demo apps | `npm run demo:node` / `demo:next`, then `npm run events:tail -- demo` |
| 4 ✅ | Agent runner + agents 1-3 (Usage, Health, Watchdog), request linking, hourly rollup | `npm run demo:node`, browse `/dependency-down` ~10×, then `npm run findings -- demo` |
| 5a ✅ | Dashboard: sign-in with password + TOTP, server-side sessions, app switcher, Overview (world map by region), App detail; `ABIGAAIL_REGION`; app-wide rollup; `@abigaail/insights`, `@abigaail/auth` | `npm run user:create -- owner`, `ABIGAAIL_REGION=LON1 npm run demo:node`, `npm run dashboard`, browser at http://localhost:4319 |
| 5b ✅ | Live view (SSE on a loopback listener 127.0.0.1:4320, relayed by the dashboard), Findings, Agents; Usage numbers on the App page (a dedicated Usage view comes later) | Set the same `ABIGAAIL_LIVE_TOKEN` (`openssl rand -base64 32`) for `npm run dev:server` and `npm run dashboard`, run `npm run demo:node`, open an app's Live tab and browse the demo (events appear after the SDK's 5 s flush); then Findings and Agents |
| 6 ✅ | Bad-traffic simulator (`apps/sim`: own server and demo on `data/sim/`, seeded history, scenarios checked against the store), README for connecting a Node or Next.js app; Health's traffic collapse counts only since the latest boot | Stop `dev:server` and the demos, `npm run sim -- list`, then `npm run sim -- run all` (about 55 min; prints PASS/FAIL per finding) and optionally `npm run sim -- run all --app next` after `npm run build -w @abigaail/demo-next`. Watch it with `ABIGAAIL_DB_PATH=./data/sim/abigaail.db` in `apps/dashboard/.env`. Follow README sections 2-6 with a scratch app |

## Phase 2, in chunks

Order is the owner's choice (DECISIONS #86): retention and alerts are pulled forward
from spec phases 4 and 3, then the scrubber, then agents 4-7, each planned against
[AGENTS.md](AGENTS.md).

| Chunk | Contents | How you test it |
|---|---|---|
| 7 ✅ | **Retention**: per-table periods (env, safe minimums), hourly batched deletion in the server for every app with rows (5-min catch-up runs while behind), physical erasure (secure_delete, one-time incremental auto_vacuum conversion when disk allows, WAL truncate), "Data kept" on the dashboard, README periods, Watchdog `retention_behind` and `vacuum_pending` | `npm run check`; sim database with `ABIGAAIL_RETAIN_EVENTS_DAYS=7`, dashboard Agents → "Data kept", `npm run findings` |
| 7b | `app:purge`: delete one app's data on request (GDPR deletion path), audited | Planned after chunk 7 |
| 8 ✅ | **Alerts**: confirmed red only (critical 2 runs in a row, now also the status rule), from the server process; one webhook (json/slack/discord/ntfy, HMAC-signed, URL rules with a private-network opt-in) and email (nodemailer, STARTTLS required); persisted dedup, 30-min cooldown, grouping, hourly cap, one recovery notice; bounded retries; Watchdog `alert_delivery_failed`; heartbeat URL; `npm run alerts:test`; Alerts page | `npm run check`. Copy `apps/server/.env.example` to `apps/server/.env`, set a webhook (e.g. an ntfy topic) and/or SMTP, plus `ABIGAAIL_DASHBOARD_URL`; `npm run alerts:test`; then `npm run dev:server` and `npm run demo:node`, open `/dependency-down` in a browser ~10× within a minute and again a minute later: one red message within about 2 min, one resolved message about 5-8 min after you stop; dashboard → Alerts and Findings. Stop the receiver (or point the webhook at a dead port) to see retries and `alert_delivery_failed` (through the other channel, or on the dashboard only with one). The simulator's server gets no alert settings (DECISIONS #78) |
| 9 | **Allowlist scrubber + privacy tests**: the SDK-side scrubber for the first free-text-like fields (lifts #12 only where it is proven safe), property and fuzz tests that forbidden values never leave the app or reach the store | Planned in chunk 9 |
| 10 | **Agent 4, Resilience**: leak = rising post-GC floor, restart loops, the route that blocks the event loop, cold-start cost; **continuous profiling** (low-rate CPU and heap sampling, flame data per route) and **memory-leak hunting** (heap snapshots analysed in the app; only class names and counts leave it) (DECISIONS #92) | Planned against AGENTS.md |
| 11 | **Agent 5, Rollout Safety**: same routes and hours before/after a release with a significance test, new error types, newly 404ing routes, crash loops after deploy, "recommend rollback" only with high impact and confidence (closes the deploy-metadata data gap); **code-aware findings** through an optional, read-only GitHub link (release → diff → file/line) (#92) | Planned against AGENTS.md |
| 12 | **Agent 6, Privacy Auditor**: scans stored values (emails, IPs, tokens, JWTs, phone numbers, IBANs, name-like route segments), verifies retention ran and `salt.bin` ≤ 1 day old, re-identification suppression | Planned against AGENTS.md |
| 13 | **Agent 7, Outbound Dependencies**: per-host normals, first-seen host, retry storms, N+1 per inbound request; **database insight**: query fingerprints with every value stripped, slow queries, N+1 queries, pool use (closes the DB query timing / pool data gap, #92) |
| 14 | **Background jobs, queues and cron**: runs, failures, duration and missed schedules (#92) | Planned against AGENTS.md |
| 15 | **Cross-service tracing**: one request followed across the owner's services (#92) | Planned against AGENTS.md |
| 16 | **AI investigator** (last): off by default; sends findings, metrics and code only, never event rows, to the Claude API or a self-hosted model; suggestions and draft PRs only (#92) | Planned against AGENTS.md | Planned against AGENTS.md |

Everything above stays read-only towards monitored apps (#92).

Later phases follow the spec: agents 8-16, backups, packaging, hosting. **Runtime security**
(loaded packages, reachable CVEs, new outbound hosts) is built with the Security (11) and
Supply Chain (13) agents (#92). An enterprise tier (SSO, roles and teams, Postgres/ClickHouse
+ HA, SIEM audit export, data residency and compliance reports, support) comes later and is
not on this roadmap yet (#93).
