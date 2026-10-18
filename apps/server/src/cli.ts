// App administration: `npm run app:create -- <name>`, `app:disable -- <name>`, `app:list`.
// Every change is written to the audit log with actor "cli".
// `npm run events:tail -- <name> [n]` prints recent events (read-only, not audited).

import { openStore } from "@abigaail/store";
import { loadConfig } from "./config.js";

const [command, name, countArg] = process.argv.slice(2);
const config = loadConfig();
const store = openStore(config.dbPath);

function fmt(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

try {
  switch (command) {
    case "create": {
      if (!name) throw new Error("usage: npm run app:create -- <name>");
      const { app, key } = store.createApp(name, "cli");
      console.log(`Created app "${app.name}" (${app.id}).`);
      console.log("");
      console.log(`  Ingest key: ${key}`);
      console.log("");
      console.log("This key is shown once and is not stored. Put it in the app's environment.");
      break;
    }
    case "disable": {
      if (!name) throw new Error("usage: npm run app:disable -- <name>");
      if (!store.disableApp(name, "cli")) throw new Error(`no enabled app named "${name}"`);
      console.log(`Disabled "${name}". Its ingest key is revoked; ingest now returns 403.`);
      break;
    }
    case "list": {
      const apps = store.listApps();
      if (!apps.length) console.log("No apps yet. Create one with: npm run app:create -- <name>");
      for (const a of apps) {
        const state = a.disabled_at === null ? "enabled" : `disabled ${fmt(a.disabled_at)}`;
        console.log(`${a.name}\t${state}\tlast event ${fmt(a.last_event_at)}\tcreated ${fmt(a.created_at)}`);
      }
      break;
    }
    case "events": {
      if (!name) throw new Error("usage: npm run events:tail -- <name> [count]");
      const app = store.appByName(name);
      if (!app) throw new Error(`no app named "${name}"`);
      const count = Math.min(Math.max(Number(countArg ?? 30) || 30, 1), 1000);
      const events = store.recentEvents(app.id, count).reverse();
      if (!events.length) console.log(`No events for "${name}" yet.`);
      for (const e of events) {
        const what =
          e.type === "request" ? `${e.method} ${e.route} ${e.status} ${e.duration_ms}ms`
          : e.type === "outbound" ? `${e.method} ${e.host} ${e.status ?? "-"} ${e.duration_ms}ms`
          : e.type === "metric" ? `${e.name}=${e.value}`
          : [e.name, e.route].filter(Boolean).join(" ");
        const who = e.visitor_hash ? ` visitor=${e.visitor_hash.slice(0, 8)} ${e.bot_class}/${e.browser ?? "-"}` : "";
        console.log(`${fmt(e.ts)}  ${e.type.padEnd(9)} ${what}${who}${e.attrs ? `  ${e.attrs}` : ""}`);
      }
      break;
    }
    default:
      throw new Error("usage: cli.js create <name> | disable <name> | list | events <name> [count]");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  store.close();
}
