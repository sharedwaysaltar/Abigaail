# Abigaail

A self-hosted, multi-agent observability platform: full technical visibility into
the apps you deploy, with no personal data collected and no third-party monitoring.

> Status: under construction, built in small chunks. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Branches

| Branch | Role |
|---|---|
| `dev`  | Single source of truth. All work is committed and pushed here as it happens. |
| `main` | Front-facing. Only receives chunks from `dev` after they pass local testing. |

## Workflow

Each chunk follows the same loop (details in [CLAUDE.md](CLAUDE.md)):

1. `git pull` on `dev`, then ask Claude (in Plan mode) to plan the next chunk.
2. Approve the plan; Claude builds it in small commits and pushes to `dev`.
3. Test locally: `npm run check` plus the manual test listed in [docs/ROADMAP.md](docs/ROADMAP.md).
4. When it passes, open a pull request `dev` -> `main`, wait for CI, merge, and tag it.

Project docs: [docs/SPEC.md](docs/SPEC.md) (requirements),
[docs/DECISIONS.md](docs/DECISIONS.md) (choices made and why),
[docs/ROADMAP.md](docs/ROADMAP.md) (progress).

## Run it on your laptop

Requirements: Node.js 22.13 or newer (Node 24 LTS recommended), git, VS Code.

```bash
git clone https://github.com/sharedwaysaltar/Abigaail.git
cd Abigaail
git checkout dev
npm install
npm run check      # type-check + all tests
```

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Run all tests once |
| `npm run test:watch` | Re-run tests as you edit |
| `npm run typecheck` | Type-check packages and tests |
| `npm run build` | Compile packages to `dist/` |

In VS Code, accept the recommended extensions (Vitest explorer) to run and debug
tests from the Testing sidebar.

## Layout

```
packages/
  schema/   Event schema v1: zero-dependency types + strict server-side validators
  core/     @abigaail/core: fail-open event client and route normaliser
docs/       Roadmap and design notes
```

## What the SDK guarantees (fail-open)

Monitoring must never become the outage. `@abigaail/core`:

- `capture()` is synchronous, never throws and never touches the network.
- Memory is bounded: at most `maxQueue` events (default 1000); overflow is dropped and counted.
- Under load (queue more than 50% full) request events are sampled; errors are always kept.
  Sampled events carry `sample_rate` so counts can be re-weighted.
- Each send is raced against a timeout (default 2s), so a hung ingest server can't stall the app.
- A circuit breaker opens after 3 consecutive failures and backs off from 30s up to 5 min.
- The flush timer is `unref`'d, so it never keeps the process alive.
- Bad configuration produces a no-op client, not an exception.

Each of these is covered by a test in `packages/core/test/client.test.ts`.

## Privacy by schema

The ingest schema is an allowlist: every object is strict, so a batch carrying any
undeclared field (email, body, headers, cookie, query, message, ...) is rejected
whole. Routes must be normalised patterns (`/user/[id]`), hosts must be bare
hostnames, stack frame paths must be project-relative, and error events carry the
error class name only, never the message. Validation errors name the offending
field but never echo its value. See `packages/schema/test/validate.test.ts`.
