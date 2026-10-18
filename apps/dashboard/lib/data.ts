import { openReadOnly, type StoreReader } from "@abigaail/store";
import { dashboardConfig } from "./config";

// One read-only connection per process: SQLite refuses every write on it, so
// nothing the dashboard does can change monitoring data.
const KEY = Symbol.for("abigaail.dashboard.reader");
type G = typeof globalThis & { [KEY]?: StoreReader };

export function reader(): StoreReader {
  const g = globalThis as G;
  return (g[KEY] ??= openReadOnly(dashboardConfig().dbPath));
}
