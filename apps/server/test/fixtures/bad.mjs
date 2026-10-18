import { parentPort } from "node:worker_threads";
parentPort.postMessage({ findings: [{ signal: "x", severity: "apocalyptic" }] });
