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
| `npm run dev:server` | Build and start the ingest server |
| `npm run app:create -- <name>` | Register an app and print its ingest key (shown once) |
| `npm run app:disable -- <name>` | Revoke an app's key (ingest returns 403) |
| `npm run app:list` | List apps, their state and last event time |

In VS Code, accept the recommended extensions (Vitest explorer) to run and debug
tests from the Testing sidebar.

## Layout

```
packages/
  schema/   Event schema v1: zero-dependency types + strict server-side validators
  core/     @abigaail/core: fail-open event client and route normaliser
  store/    @abigaail/store: SQLite store (node:sqlite); every query scoped by app_id
apps/
  server/   Ingest server (POST /ingest) and the app admin CLI
docs/       Roadmap and design notes
```

## Run the ingest server

```bash
npm run app:create -- demo     # prints an abk_... key once; copy it
npm run dev:server             # listens on http://127.0.0.1:4318/ingest
```

In a second terminal, send a batch (replace the key):

```bash
curl -i http://127.0.0.1:4318/ingest \
  -H 'content-type: application/json' \
  -H 'x-abigaail-key: abk_PASTE_YOUR_KEY' \
  -d '{"schema_version":1,"sdk":{"name":"curl","version":"1"},"release":"abc123","environment":"development",
       "events":[{"type":"request","event_id":"3f2b8c1e-9a4d-4e7f-8b2a-1c5d6e7f8a9b","client_ts":0,
                  "method":"GET","route":"/user/[id]","status":200,"duration_ms":12}]}'
```

Expect `202 {"accepted":1,"duplicates":0}`. Send it again and you get `"duplicates":1`.
A wrong key gives 401, and adding a field such as `"email":"x"` to the event gives 400.
Data lives in `./data/` (git-ignored): the database `abigaail.db` and the daily
visitor-hash salt `salt.bin`, which is kept out of the database on purpose. Configure with
`ABIGAAIL_DB_PATH`, `ABIGAAIL_SALT_PATH`, `ABIGAAIL_HOST` (default `127.0.0.1`) and
`ABIGAAIL_PORT` (default `4318`). Before hosting anywhere, go through
[docs/HOSTING.md](docs/HOSTING.md).

The client IP and user agent may be sent once per request event in `transient`. Ingest
uses them in memory for a daily-salted, per-app visitor hash and a browser/bot class,
then discards them; they are never stored (see `apps/server/test/privacy.test.ts`).

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
