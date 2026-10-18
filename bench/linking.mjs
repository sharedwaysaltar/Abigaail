// Linking benchmark: req/s of a local server with @abigaail/node linking
// outbound calls to their request (AsyncLocalStorage) vs linkOutbound: false.
// Not part of `npm run check` or CI: timing on shared runners is too noisy to
// assert on. Run with `npm run bench`; results go in docs/DECISIONS.md.
//
// Rounds alternate on/off so drift (thermal, other load) hits both equally,
// and the median round of each is compared.

import http from "node:http";
import { init } from "@abigaail/node";

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 8);
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 4000);
const CONCURRENCY = 32;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const upstream = await listen((_req, res) => res.end("ok"));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

const scenarios = {
  // Worst case for relative overhead: the handler does almost nothing.
  minimal: (_req, res) => res.end("ok"),
  // A typical API handler: awaits one outbound call before answering.
  outbound: async (_req, res) => {
    await (await fetch(upstreamUrl)).text();
    res.end("ok");
  },
};

async function load(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  let next = 0;
  const one = () =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/bench", agent }, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });
  const worker = async () => {
    while (next++ < REQUESTS) await one();
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (performance.now() - t0) / 1000;
  agent.destroy();
  return REQUESTS / secs;
}

async function round(scenario, linkOutbound) {
  const sdk = init({
    endpoint: "http://127.0.0.1:9/ingest",
    ingestKey: "bench",
    release: "bench",
    environment: "test",
    linkOutbound,
    metricsIntervalMs: 0,
    heartbeatIntervalMs: 0,
    flushIntervalMs: 50,
    // Events are discarded: this measures capture, not sending.
    transport: async () => "ok",
    onInternalError: () => {},
    env: {},
  });
  const server = await listen(scenarios[scenario]);
  try {
    return await load(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
    await sdk.shutdown(100);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log(`node ${process.version}, ${ROUNDS} rounds x ${REQUESTS} requests, concurrency ${CONCURRENCY}`);
// Warm up the JIT before measuring.
await round("minimal", true);
await round("minimal", false);
const only = process.env.BENCH_ONLY;
for (const scenario of Object.keys(scenarios).filter((k) => !only || k === only)) {
  const on = [];
  const off = [];
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2) {
      off.push(await round(scenario, false));
      on.push(await round(scenario, true));
    } else {
      on.push(await round(scenario, true));
      off.push(await round(scenario, false));
    }
  }
  const mOn = median(on);
  const mOff = median(off);
  const diff = ((mOn - mOff) / mOff) * 100;
  console.log(
    `${scenario.padEnd(9)} linking on ${mOn.toFixed(0)} req/s, off ${mOff.toFixed(0)} req/s, ` +
      `difference ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%`,
  );
}
await new Promise((r) => upstream.close(r));
