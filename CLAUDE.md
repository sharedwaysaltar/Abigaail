# Abigaail

Self-hosted, multi-agent observability platform: full technical visibility into
deployed apps with zero personal data. Requirements: @docs/SPEC.md.
Decisions already made (do not re-litigate): @docs/DECISIONS.md.
Progress and next chunk: @docs/ROADMAP.md.

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
| `npm run app:create -- <name>` / `app:disable` / `app:list` | App admin CLI (audited) |
| `npm run events:tail -- <name> [n]` | Print an app's recent events (read-only) |
| `npm run demo:node` / `npm run demo:next` | Run a demo app (needs `apps/demo-*/.env`, see `.env.example`) |

## Layout

- `packages/schema`: event schema v1. `src/index.ts` is types/constants (zero deps);
  `src/validate.ts` is strict zod validation for the server.
- `packages/core`: `@abigaail/core` SDK (queue, breaker, sampler, transport, route normaliser).
- `packages/node`: `@abigaail/node` adapter (`diagnostics_channel` capture, flags, stack frames, metrics).
- `packages/next`: `@abigaail/next` (`register` / `onRequestError` for `instrumentation.ts`, routes manifest).
- `packages/store`: `@abigaail/store`, the only code that touches SQL (`node:sqlite`, migrations).
- `apps/server`: ingest server (`src/server.ts`), derivations (`src/derive.ts`), daily salt
  file (`src/salt.ts`, never in the DB), admin CLI. Hosting requirements: docs/HOSTING.md.
- `apps/demo-node`, `apps/demo-next`: demo apps (not part of `npm run build`).
- Tests live in `packages/*/test/*.test.ts` and `apps/*/test/*.test.ts` and import packages by name
  (`@abigaail/core`), resolved to sources via `vitest.config.ts` and `tsconfig.json`.
