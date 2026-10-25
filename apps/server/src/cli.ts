// App administration: `npm run app:create -- <name>`, `app:disable -- <name>`, `app:list`,
// `app:purge -- <name> [--dry-run]` (purge.ts).
// Every change is written to the audit log with actor "cli".
// `npm run events:tail -- <name> [n]` prints recent events (read-only, not audited).
// `npm run findings -- <name>` prints the app's status and open findings.
// `npm run agents:once` runs retention, the rollup and every agent once, then prints findings.

import { openStore, type Finding } from "@abigaail/store";
import { Runner } from "./agents/runner.js";
import { Retention } from "./retention.js";
import { FINDINGS } from "./agents/thresholds.js";
import { loadConfig } from "./config.js";
import { prompt } from "./prompt.js";
import { runPurgeCommand } from "./purge.js";

const [command, name, countArg] = process.argv.slice(2);
const config = loadConfig();
const store = openStore(config.dbPath);

function fmt(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

const ICON: Record<string, string> = { red: "🔴", amber: "🟠", grey: "⚪", green: "🟢" };

function printFinding(f: Finding): void {
  console.log(`  [${f.severity}] ${f.summary}`);
  if (f.cause) console.log(`      cause:  ${f.cause}`);
  console.log(`      action: ${f.action}`);
  console.log(`      ${f.fingerprint}  hits=${f.hits} misses=${f.misses}  since ${fmt(f.first_seen)}`);
}

function printStatus(name: string): void {
  const app = store.appByName(name);
  if (!app) throw new Error(`no app named "${name}"`);
  const { status, findings } = store.appStatus(app.id, { now: Date.now(), freshMs: FINDINGS.statusFreshMs });
  console.log(`${ICON[status]} ${app.name}: ${status}`);
  if (!findings.length) console.log("  no open findings");
  for (const f of findings) printFinding(f);
}

async function main(): Promise<void> {
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
    case "purge": {
      process.exitCode = await runPurgeCommand(process.argv.slice(3), {
        store,
        ask: (q) => prompt(q, false),
        print: (line) => console.log(line),
      });
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
        const ids = e.type === "request" ? `  id=${e.event_id.slice(0, 8)}` : e.parent_id ? `  parent=${e.parent_id.slice(0, 8)}` : "";
        console.log(`${fmt(e.ts)}  ${e.type.padEnd(9)} ${what}${who}${ids}${e.attrs ? `  ${e.attrs}` : ""}`);
      }
      break;
    }
    case "findings": {
      if (!name) throw new Error("usage: npm run findings -- <name>");
      printStatus(name);
      const system = store.systemFindings();
      if (system.length) {
        console.log("\nAbigaail itself:");
        for (const f of system) printFinding(f);
      }
      break;
    }
    case "agents-once": {
      const retention = await new Retention({ store, days: config.retention, authDbPath: config.authDbPath, log: (m) => console.error(m) }).runOnce();
      const total = Object.values(retention.deleted).reduce((a, b) => a + (b ?? 0), 0);
      console.log(`retention: ${retention.outcome}${retention.error_class ? ` (${retention.error_class})` : ""}, ${total} row(s) deleted${retention.behind ? ", work left" : ""}`);
      const runner = new Runner({ store, dbPath: config.dbPath, saltPath: config.saltPath, retention: config.retention, log: (m) => console.error(m) });
      for (const { run, findings } of await runner.runOnce()) {
        const err = run.error_class ? ` (${run.error_class})` : "";
        console.log(`${run.agent}: ${run.outcome}${err}, ${findings} finding(s), ${run.finished_at - run.started_at} ms`);
      }
      console.log("");
      for (const app of store.listApps()) printStatus(app.name);
      const system = store.systemFindings();
      console.log(system.length ? "\nAbigaail itself:" : "\nAbigaail itself: no open findings");
      for (const f of system) printFinding(f);
      break;
    }
    default:
      throw new Error("usage: cli.js create <name> | disable <name> | purge <name> [--dry-run] | list | events <name> [count] | findings <name> | agents-once");
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  store.close();
}
