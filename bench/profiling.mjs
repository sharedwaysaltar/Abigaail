// Profiling overhead benchmark (DECISIONS #121): req/s, RSS, event-loop delay
// and the profiler's own main-thread work, for a local server with
// @abigaail/node in four arms: runtime signals off, runtime signals on (the
// default), profiling on without CPU windows (the heap sampler and the
// session), and CPU sampling back to back (the worst case: the real duty cycle
// is a 10 s window a minute, a sixth of that). Not part of
// `npm run check` (timing on shared machines is too noisy to assert on).
// Run with `npm run bench:profiling`; results go in docs/DECISIONS.md.
//
// Arms rotate within each round so drift hits all of them, and medians are compared.

import http from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { init } from "@abigaail/node";

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 6);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 10);
const CONCURRENCY = 32;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// A deep stack of real work, so profiles have many frames to merge.
function depth(n, x) {
  if (n === 0) {
    let s = 0;
    for (let i = 0; i < 4000; i++) s += Math.sqrt(i + x);
    return s;
  }
  return depth(n - 1, x + 1) + 1;
}

const scenarios = {
  // Worst case for relative overhead: the handler does almost nothing.
  minimal: (_req, res) => res.end("ok"),
  // CPU work under a 40-frame stack (about 0.1 ms), the profiler's busiest case.
  deep: (_req, res) => res.end(String(depth(40, 1))),
};

async function load(port, seconds) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  let done = 0;
  const until = performance.now() + seconds * 1000;
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
    while (performance.now() < until) {
      await one();
      done++;
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  agent.destroy();
  return done / ((performance.now() - t0) / 1000);
}

const ARMS = {
  off: { runtimeSignals: false },
  runtime: {},
  // Profiling on, CPU windows never due: the sampling heap profiler and the session alone.
  heap: { profiling: true, profilerTiming: { windowMs: 3_000, everyMs: 3_600_000 } },
  // CPU sampling back to back (3 s windows from 1 s in): the worst case, 6x the real duty cycle.
  // (The load rule is off here: a saturating benchmark would otherwise skip every window, as it should in an app.)
  cpu: { profiling: true, profilerTiming: { windowMs: 3_000, everyMs: 1_000, ignoreLoad: true } },
};

async function round(scenario, arm) {
  const work = [];
  if (global.gc) global.gc();
  const rss0 = process.memoryUsage().rss;
  const sdk = init({
    endpoint: "http://127.0.0.1:9/ingest",
    ingestKey: "bench",
    release: "bench",
    environment: "test",
    metricsIntervalMs: 1000,
    heartbeatIntervalMs: 0,
    flushIntervalMs: 50,
    // Events are discarded: this measures capture and profiling, not sending.
    transport: async () => ({ result: "ok", features: ["runtime_v1", "profile_v1"] }),
    onInternalError: () => {},
    onProfilerWindow: (w) => w.startMs !== undefined && work.push(w),
    env: {},
    ...ARMS[arm],
  });
  await sdk.flush();
  const server = await listen(scenarios[scenario]);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  try {
    const rps = await load(server.address().port, SECONDS);
    return { rps, rssMb: (process.memoryUsage().rss - rss0) / 1048576, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6, work };
  } finally {
    delay.disable();
    await new Promise((r) => server.close(r));
    await sdk.shutdown(100);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};

console.log(`node ${process.version}, ${ROUNDS} rounds x ${SECONDS} s, concurrency ${CONCURRENCY}`);
await round("minimal", "off");
const only = process.env.BENCH_ONLY;
for (const scenario of Object.keys(scenarios).filter((k) => !only || k === only)) {
  const res = Object.fromEntries(Object.keys(ARMS).map((k) => [k, []]));
  const names = Object.keys(ARMS).filter((k) => !process.env.BENCH_ARMS || process.env.BENCH_ARMS.split(",").includes(k));
  for (let i = 0; i < ROUNDS; i++) {
    for (let k = 0; k < names.length; k++) {
      const arm = names[(i + k) % names.length];
      res[arm].push(await round(scenario, arm));
    }
  }
  const base = median(res.off.map((r) => r.rps));
  for (const arm of names) {
    if (!res[arm].length) continue;
    const rps = median(res[arm].map((r) => r.rps));
    const work = res[arm].flatMap((r) => r.work.map((w) => w.workMs));
    const starts = res[arm].flatMap((r) => r.work.map((w) => w.startMs ?? 0));
    console.log(
      `${scenario.padEnd(8)} ${arm.padEnd(10)} ${rps.toFixed(0).padStart(6)} req/s (${(((rps - base) / base) * 100).toFixed(1).padStart(5)}%)` +
        `  rss +${median(res[arm].map((r) => r.rssMb)).toFixed(1)} MB` +
        `  loop p99 ${median(res[arm].map((r) => r.p99)).toFixed(1)} ms, max ${median(res[arm].map((r) => r.max)).toFixed(1)} ms` +
        (work.length ? `  window start median ${median(starts).toFixed(1)} ms, max ${Math.max(...starts).toFixed(1)} ms; read median ${median(work).toFixed(1)} ms, max ${Math.max(...work).toFixed(1)} ms (${work.length} windows)` : ""),
    );
  }
}
