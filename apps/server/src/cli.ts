// App administration: `npm run app:create -- <name>`, `app:disable -- <name>`, `app:list`.
// Every change is written to the audit log with actor "cli".

import { openStore } from "@abigaail/store";
import { loadConfig } from "./config.js";

const [command, name] = process.argv.slice(2);
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
    default:
      throw new Error("usage: cli.js create <name> | disable <name> | list");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  store.close();
}
