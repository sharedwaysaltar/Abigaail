# Abigaail

Self-hosted, multi-agent observability platform: full technical visibility into
deployed apps with zero personal data. Requirements: @docs/SPEC.md.
Decisions already made (do not re-litigate): @docs/DECISIONS.md.
Progress and next chunk: @docs/ROADMAP.md.
How agents must think (plan every agent against it): @docs/AGENTS.md.

## How we work

- **Plan first.** At the start of each chunk, propose a short plan and wait for the
  owner's approval before writing code.
- **One chunk at a time.** Build it, run checks, push, then stop so the owner can test.
- **Branches:** commit and push to `dev` as work happens. Never push to `main`;
  `main` only changes through a `dev` -> `main` pull request the owner merges.
  Never force-push.
- **Only one Claude session works on `dev` at a time.** Run `git pull` before starting.
- **Before every commit:** `npm run check` must pass (type-check + all tests).
- **Tests prove the hard requirements.** Fail-open, allowlist/validation, hashing and
  dedup changes need tests. When adding a safety test, confirm it fails if the
  protection is removed.
- **Minimal dependencies.** Each new dependency needs a one-line justification in
  docs/DECISIONS.md.
- **New decisions** go in docs/DECISIONS.md; when a chunk is done, mark it in
  docs/ROADMAP.md.
- Never put model identifiers in commits or files. Commit trailers are exactly
  `Co-Authored-By: Claude <noreply@anthropic.com>`, without a model name.

## Non-negotiables (from the spec, condensed)

- The SDK never throws into, blocks, or slows the host app. Bounded memory, timeouts,
  circuit breaker, no-op on misconfiguration.
- Never collect: raw IPs (beyond the transient ingest field), emails, names, user IDs,
  cookies, tokens, auth headers, bodies, form inputs, query values, free text.
- Abigaail is read-only towards monitored apps. Ingest keys are write-only and per app.
- Every store query is scoped by `app_id`.
- Routes are normalised; never store raw URLs as dimensions.

## Commands

| Command | Use |
|---|---|
| `npm install` | Install workspace dependencies |
| `npm run check` | Type-check + tests; run before every commit |
| `npm test` / `npm run test:watch` | Tests only |
| `npm run build` | Compile packages to `dist/` |
| `npm run dev:server` | Build and start the ingest server |
| `npm run dashboard` / `npm run dashboard:dev` | Build and start the dashboard on http://localhost:4319 (needs `apps/dashboard/.env`, see `.env.example`) |
| `npm run user:create -- <name>` / `user:disable` / `user:reset-mfa` / `user:unlock` | Dashboard user admin (audited; needs `ABIGAAIL_DASHBOARD_SECRET`) |
| `npm run app:create -- <name>` / `app:disable` / `app:list` | App admin CLI (audited) |
| `npm run events:tail -- <name> [n]` | Print an app's recent events (read-only) |
| `npm run findings -- <name>` | Print an app's status and open findings, plus Abigaail's own |
| `npm run agents:once` | Run retention, the rollup and every agent once now, then print findings |
| `npm run alerts:test` | Send one sample alert through every configured channel (needs `apps/server/.env`, see `.env.example`) |
| `npm run sim -- list` / `run <scenario\|all> [--app next]` / `verify` / `reset` | Bad-traffic simulator: own server + demo on `data/sim/`, checks every expected finding (stop `dev:server` first) |
| `npm run bench` | Linking benchmark (not part of `check`; results go in DECISIONS #38) |
| `npm run demo:node` / `npm run demo:next` | Run a demo app (needs `apps/demo-*/.env`, see `.env.example`) |

## Layout

- `packages/schema`: event schema v1. `src/index.ts` is types/constants (zero deps);
  `src/validate.ts` is strict zod validation for the server.
- `packages/core`: `@abigaail/core` SDK (queue, breaker, sampler, transport, route normaliser).
- `packages/node`: `@abigaail/node` adapter (`diagnostics_channel` capture, flags, stack frames, metrics).
- `packages/next`: `@abigaail/next` (`register` / `onRequestError` for `instrumentation.ts`, routes manifest).
- `packages/store`: `@abigaail/store`, the only code that touches SQL (`node:sqlite`, migrations).
  `StoreReader` holds every read (agents and the dashboard get it over a read-only connection);
  `Store` adds writes. `AuthStore` (`src/auth.ts`) is the separate dashboard auth database.
- `packages/insights`: `@abigaail/insights`, baselines and statistics shared by agents and dashboard,
  plus the dashboard's read models (`src/views.ts`).
- `packages/auth`: `@abigaail/auth`, scrypt passwords, TOTP, sealed secrets, sign-in and session rules.
- `apps/server`: ingest server (`src/server.ts`), derivations (`src/derive.ts`), daily salt
  file (`src/salt.ts`, never in the DB), admin CLI. Hosting requirements: docs/HOSTING.md.
  `src/live.ts`: the Live feed (SSE, 127.0.0.1 only, bearer token, bounded; `LIVE` holds its limits).
  `src/retention.ts`: hourly deletion past each period (`RETENTION` in `agents/thresholds.ts`), runs even with
  agents off; erasure helpers (secure_delete, incremental vacuum, WAL truncate) are `packages/store/src/vacuum.ts`.
  What it may carry is `toLiveEvent` / `LIVE_FIELDS` in `packages/store/src/live.ts`.
  `src/alerts/`: the alerter (`alerter.ts`: sweep, dedup, cooldown, bounded sender), `channels.ts` (webhook, nodemailer),
  `url.ts` (where it may send; checked again at every connection), `format.ts` (`ITEM_FIELDS`, the only fields sent),
  `heartbeat.ts`, `config.ts` (env only), `cli.ts` (`alerts:test`). Red = `isRed` in the store, shared with status.
- `apps/server/src/agents`: agent runner (`runner.ts`, one worker per run, read-only DB),
  registry (one line per agent, plus its `SCHEDULE` line in `packages/insights/src/thresholds.ts`),
  `thresholds.ts` (every tunable), agents. `ABIGAAIL_AGENTS=off`
  disables them.
- `apps/server/src/users.ts`: dashboard user CLI (`user-cli.ts` is its entry point).
- `apps/dashboard`: Next.js dashboard, read-only on the store. `server.mjs` wraps Next (peer address,
  CSP nonce, security headers); every page/route calls `requireSession()` (`lib/session.ts`).
  `lib/regions.ts` maps region codes to coordinates; `lib/worldmap.ts` is generated by `scripts/worldmap.mjs`.
  API routes a script calls use `requireApiSession()` (401, read-only, never a redirect). `lib/live.ts` relays
  the Live feed (pull-based, closed on sign-out).
- `apps/sim`: the bad-traffic simulator. `scenarios.ts` (what each does and must produce), `traffic.ts` +
  `model.ts` (the traffic and demo models shared by seeding and the replay tests), `guard.ts` (localhost
  only), `paths.ts` (data/sim only, realpath-checked), `verify.ts` (judges findings), `replay.ts` (simulated
  clock, used by `test/scenarios.test.ts`), `stack.ts`/`driver.ts`/`main.ts` (the live run).
- `apps/demo-node`, `apps/demo-next`: demo apps (not part of `npm run build`). demo-node's fault switches
  (`faults.mjs`) answer only the simulator's IPC channel.
- Tests live in `packages/*/test/*.test.ts` and `apps/*/test/*.test.ts` and import packages by name
  (`@abigaail/core`), resolved to sources via `vitest.config.ts` and `tsconfig.json`.
