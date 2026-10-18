import { resolve } from "node:path";

/** Dashboard configuration from the environment (secrets never live in the repo). Paths are relative to the repo root. */
export function dashboardConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    dbPath: resolve(/*turbopackIgnore: true*/ env.ABIGAAIL_DB_PATH || "./data/abigaail.db"),
    authDbPath: resolve(/*turbopackIgnore: true*/ env.ABIGAAIL_AUTH_DB_PATH || "./data/auth.db"),
  };
}
