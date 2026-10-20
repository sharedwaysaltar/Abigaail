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

Later phases follow the original spec (scrubber + agents 4-7, alerts, retention,
backups, packaging, hosting).
