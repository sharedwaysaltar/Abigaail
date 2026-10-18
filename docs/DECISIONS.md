# Decisions log

Choices made while building, with the reason. Newest last. Change one only by
adding a new entry that supersedes it.

| # | Decision | Why |
|---|---|---|
| 1 | Name is **Abigaail** everywhere; packages are `@abigaail/*`. | Owner's choice (replaces the working name "Sentinel"). |
| 2 | Build and test on a laptop first; hosting decided later. | Owner's choice. |
| 3 | `dev` is the single source of truth; `main` only receives tested chunks via PR. | Owner's choice. |
| 4 | Abigaail is designed independently of The Well's repo. Target apps are assumed to be long-running Node processes; serverless is a separate adapter. | The Well repo is out of date (it now runs on a droplet, not Vercel). |
| 5 | Node >= 22.13, TypeScript 7, npm workspaces, Vitest. | Built-in `node:sqlite` and test tooling with fake timers; no build tool beyond `tsc`. |
| 6 | SDK has zero runtime dependencies. `@abigaail/schema` index is types + constants only; zod lives in `@abigaail/schema/validate`, used server-side. | Lesson 1: the SDK must be light and never become the outage. |
| 7 | Server schema is strict (unknown fields reject the batch); errors carry the class name only, never the message; frame paths must be relative. | Lesson 3: server half of the allowlist. Validation issues name fields, never values. |
| 8 | Client IP and user agent travel once in a `transient` field; ingest uses them in memory for geo, bot class and the visitor hash, then discards them. Visitor hash uses a random daily salt that is deleted at day end. | Spec: "geo lookup uses the IP in memory at ingest, then discards it." Hashes cannot be linked across days. |
| 9 | Request capture via Node `diagnostics_channel` (`http.server.*`, `undici:*`, `http.client.*`). | Read-only, no monkey-patching, works across Next/Express/Fastify. Lesson 4. |
| 10 | Routes come from framework patterns; fallback heuristic replaces ID-like segments with `[id]`; max 500 routes per process, rest become `other`. | Lesson 5. |
| 11 | Server runs as two processes: `server` (ingest, SSE, scheduler, alerter) and `dashboard` (read-only). Agents each run in a `worker_thread` with a hard timeout. | Lessons 2 and 10: alerts survive the dashboard being down; a looping agent is terminated. |
| 12 | Until the Phase 2 scrubber exists, no free text is sent at all. | Lesson 3, applied before the scrubber lands. |
| 13 | A 401/403 from ingest trips the SDK circuit breaker. | A wrong key should back off, not retry every flush. |
