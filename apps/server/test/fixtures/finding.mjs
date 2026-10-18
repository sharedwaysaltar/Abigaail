// A well-behaved agent: one finding about Abigaail itself, after an optional delay.
import { parentPort, workerData } from "node:worker_threads";
const delay = workerData.agent === "slow" ? 300 : 0;
setTimeout(() => {
  parentPort.postMessage({
    findings: [{ app_id: null, signal: "x", subject: "s", severity: "warning", summary: "sum", action: "act", evidence: { n: 1 } }],
    evaluated: [null],
    failed: [],
  });
}, delay);
