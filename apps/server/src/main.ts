// Starts the ingest server: `npm run dev:server`.

import { openStore } from "@abigaail/store";
import { Runner } from "./agents/runner.js";
import { loadConfig } from "./config.js";
import { openSaltFile, type SaltFile } from "./salt.js";
import { createServer } from "./server.js";

const config = loadConfig();
let salt: SaltFile;
try {
  // Rotates a salt left over from an earlier day before the first request.
  salt = openSaltFile(config.saltPath);
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "Error");
  console.error(`[abigaail] cannot open the salt file ${config.saltPath} (${code}); not starting`);
  process.exit(1);
}
const store = openStore(config.dbPath);
const runner = config.agents ? new Runner({ store, dbPath: config.dbPath, saltPath: config.saltPath }) : undefined;

const server = createServer({
  store,
  salt,
  healthz: () => (runner ? { ok: runner.watchdogFresh() } : { ok: true, agents: "off" }),
});
server.listen(config.port, config.host, () => {
  console.log(`[abigaail] ingest listening on http://${config.host}:${config.port}/ingest (db: ${config.dbPath})`);
  if (runner) {
    runner.start();
    console.log("[abigaail] agents running");
  } else {
    console.log("[abigaail] agents are off (ABIGAAIL_AGENTS=off)");
  }
});

function shutdown(): void {
  void runner?.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  // Do not hang on slow clients during shutdown.
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 5000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
