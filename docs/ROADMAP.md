# Roadmap

Everything runs on a laptop first (VS Code + browser). Hosting comes later.

## Phase 1, in chunks

| Chunk | Contents | How you test it |
|---|---|---|
| 1 ✅ | Monorepo, event schema v1, `@abigaail/core` fail-open SDK | `npm run check` |
| 2 ✅ | `@abigaail/store` (SQLite) + ingest server | `npm run dev:server`, curl a batch |
| 3 | `@abigaail/node` + `@abigaail/next` adapters, demo app | Run demo app, watch events arrive |
| 4 | Agent runner + agents 1-3 (Usage, Health, Watchdog) | Findings appear in the store |
| 5 | Dashboard: login + MFA, Status, Live, Usage | Browser at localhost |
| 6 | Bad-traffic simulator, README for connecting an app | Run simulator, see findings |

Later phases follow the original spec (scrubber + agents 4-7, alerts, retention,
backups, packaging, hosting).
