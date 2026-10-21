// Starts the ingest server: `npm run dev:server`.

import { existsSync } from "node:fs";
import { openAuthStore, openStore } from "@abigaail/store";
import { Runner } from "./agents/runner.js";
import { Alerter } from "./alerts/alerter.js";
import { makeChannels } from "./alerts/channels.js";
import { Heartbeat } from "./alerts/heartbeat.js";
import { loadConfig, type Config } from "./config.js";
import { LIVE, LiveHub, startLive } from "./live.js";
import { convertForShrinking, Retention } from "./retention.js";
import { openSaltFile, type SaltFile } from "./salt.js";
import { createServer } from "./server.js";

const log = (msg: string) => console.error(`[abigaail] ${msg}`);
let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // A bad setting (say, a retention period below its minimum) stops the server.
  log(`${err instanceof Error ? err.message : String(err)}; not starting`);
  process.exit(1);
}
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
// One-time switch to incremental vacuum, before ingest listens and before any agent worker starts.
convertForShrinking(store, "database", log);
if (existsSync(config.authDbPath)) {
  const auth = openAuthStore(config.authDbPath);
  convertForShrinking(auth, "auth database", log);
  auth.close();
}
// Runs whether or not the agents are on: data must age out either way.
const retention = new Retention({ store, days: config.retention, authDbPath: config.authDbPath });
// Alerts are sent from this process, so they work with the dashboard down (DECISIONS #11).
const channels = makeChannels(config.alerts);
try {
  store.writeAlertChannels(channels.map((c) => ({ channel: c.name, label: c.label })));
} catch {
  log("alerts: could not record the configured channels");
}
const alerter = channels.length
  ? new Alerter({ store, channels, ...(config.alerts.dashboardUrl ? { dashboardUrl: config.alerts.dashboardUrl } : {}) })
  : undefined;
const runner = config.agents
  ? new Runner({ store, dbPath: config.dbPath, saltPath: config.saltPath, retention: config.retention, alerts: !!alerter })
  : undefined;
const healthz = (): { ok: boolean; agents?: "off" } => (runner ? { ok: runner.watchdogFresh() } : { ok: true, agents: "off" });
const heartbeat = config.alerts.heartbeatUrl ? new Heartbeat({ url: config.alerts.heartbeatUrl, healthy: () => healthz().ok }) : undefined;
const hub = new LiveHub();

const server = createServer({
  store,
  salt,
  live: hub,
  healthz,
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
  retention.start();
  if (runner) {
    runner.start();
    console.log("[abigaail] agents running");
  } else {
    console.log("[abigaail] agents are off (ABIGAAIL_AGENTS=off)");
  }
  alerter?.start();
  console.log(alerter ? `[abigaail] alerts: ${channels.map((c) => c.label).join("; ")}` : "[abigaail] alerts are off (no channel configured)");
  heartbeat?.start();
  if (heartbeat) console.log("[abigaail] heartbeat on (ABIGAAIL_HEARTBEAT_URL)");
});

function shutdown(): void {
  void runner?.stop();
  alerter?.stop();
  heartbeat?.stop();
  void retention.stop();
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
