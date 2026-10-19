import { resolve } from "node:path";

/** Dashboard configuration from the environment (secrets never live in the repo). Paths are relative to the repo root. */
export function dashboardConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    dbPath: resolve(/*turbopackIgnore: true*/ env.ABIGAAIL_DB_PATH || "./data/abigaail.db"),
    authDbPath: resolve(/*turbopackIgnore: true*/ env.ABIGAAIL_AUTH_DB_PATH || "./data/auth.db"),
    /** The server's live feed, always on this machine (DECISIONS #69). */
    livePort: Number(env.ABIGAAIL_LIVE_PORT || 4320),
    /** Server-side only: never sent to the browser. Empty: the Live view is off. */
    liveToken: env.ABIGAAIL_LIVE_TOKEN ?? "",
  };
}
