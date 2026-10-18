// Starts the ingest server: `npm run dev:server`.

import { openStore } from "@abigaail/store";
import { loadConfig } from "./config.js";
import { utcDay } from "./derive.js";
import { createServer } from "./server.js";

const config = loadConfig();
const store = openStore(config.dbPath);
// Deletes any salt left over from an earlier day before the first request.
store.saltFor(utcDay(Date.now()));

const server = createServer({ store });
server.listen(config.port, config.host, () => {
  console.log(`[abigaail] ingest listening on http://${config.host}:${config.port}/ingest (db: ${config.dbPath})`);
});

function shutdown(): void {
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
