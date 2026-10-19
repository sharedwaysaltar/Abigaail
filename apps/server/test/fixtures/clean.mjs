// An agent that evaluated Abigaail itself and found nothing.
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ findings: [], evaluated: [null], failed: [] });
