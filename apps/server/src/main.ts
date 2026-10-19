// Starts the ingest server: `npm run dev:server`.

import { openStore } from "@abigaail/store";
import { Runner } from "./agents/runner.js";
import { loadConfig } from "./config.js";
import { LIVE, LiveHub, startLive } from "./live.js";
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
const hub = new LiveHub();

const server = createServer({
  store,
  salt,
  live: hub,
  healthz: () => (runner ? { ok: runner.watchdogFresh() } : { ok: true, agents: "off" }),
});
// Loopback only (LIVE.host); off, with one log line, without ABIGAAIL_LIVE_TOKEN.
const live = await startLive({ hub, store, token: config.liveToken, port: config.livePort }).catch((err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code ?? "Error";
  console.error(`[abigaail] live view off: cannot listen on ${LIVE.host}:${config.livePort} (${code})`);
  return undefined;
});
if (live) console.log(`[abigaail] live feed on http://${LIVE.host}:${config.livePort}/live (loopback only)`);
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
  live?.close();
  live?.closeAllConnections();
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
