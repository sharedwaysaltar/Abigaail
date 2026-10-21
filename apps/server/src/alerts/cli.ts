// `npm run alerts:test`: send one sample alert through every configured
// channel now and say whether it was delivered. Recorded and audited (actor "cli").

import { openStore } from "@abigaail/store";
import { loadConfig } from "../config.js";
import { sendTestAlert } from "./alerter.js";
import { makeChannels } from "./channels.js";

let code = 0;
try {
  const config = loadConfig();
  const channels = makeChannels(config.alerts);
  if (!channels.length) {
    console.error("No alert channel is configured. Set ABIGAAIL_ALERT_WEBHOOK_URL and ABIGAAIL_ALERT_WEBHOOK_SECRET, and/or ABIGAAIL_SMTP_HOST, ABIGAAIL_ALERT_EMAIL_FROM and ABIGAAIL_ALERT_EMAIL_TO (see README, Alerts).");
    code = 1;
  } else {
    const store = openStore(config.dbPath);
    try {
      for (const { channel, result } of await sendTestAlert(store, channels, config.alerts.dashboardUrl)) {
        const label = channels.find((c) => c.name === channel)!.label;
        if (result.ok) console.log(`✓ ${label}: delivered`);
        else {
          console.log(`✗ ${label}: not delivered (${result.error ?? "Error"}${result.code !== undefined ? `, code ${result.code}` : ""})`);
          code = 1;
        }
      }
    } finally {
      store.close();
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
}
process.exitCode = code;
