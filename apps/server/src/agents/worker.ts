// Worker entry: runs one agent once over a read-only connection and posts the
// result back. The runner terminates it if it overruns its timeout, so a
// looping agent never blocks ingest or the other agents (DECISIONS #11).

import { parentPort, workerData } from "node:worker_threads";
import { openReadOnly } from "@abigaail/store";
import { evaluate } from "./evaluate.js";
import { agentByName } from "./registry.js";
import type { WorkerInput } from "./types.js";

const input = workerData as WorkerInput;
const agent = agentByName(input.agent);
if (!agent) throw new RangeError("unknown agent");

const store = openReadOnly(input.config.dbPath);
try {
  const result = evaluate(agent, {
    store,
    apps: store.listApps(),
    now: input.now,
    windowEnd: input.windowEnd,
    config: input.config,
  });
  parentPort!.postMessage(result);
} finally {
  store.close();
}
