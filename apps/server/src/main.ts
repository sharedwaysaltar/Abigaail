// Starts the ingest server: `npm run dev:server`.

import { openStore } from "@abigaail/store";
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

const server = createServer({ store, salt });
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
