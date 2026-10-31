// An agent that reports the environment it was given (the GitHub token must not be in it).
import { parentPort } from "node:worker_threads";
parentPort.postMessage({
  findings: [{ app_id: null, signal: "env", subject: "", severity: "info", summary: "env", action: "none", evidence: { env: { ...process.env } } }],
  evaluated: [null],
  failed: [],
});
