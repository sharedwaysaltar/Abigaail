// `npm run sim -- <command>`: the bad-traffic simulator.
//
//   list                               scenarios and the findings each must produce
//   run <scenario|all> [--app node|next] [--seed n]
//                                      fresh data/sim/, seeded history, own server + demo app,
//                                      traffic, then checks every expected finding
//   verify                             re-check the last run against data/sim/ now
//   reset                              delete data/sim/ (and nothing else)
//
// It only targets demo apps on this machine and never touches data/abigaail.db.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openReadOnly, openStore, type StoreReader } from "@abigaail/store";
import { Driver } from "./driver.js";
import type { Faults } from "./model.js";
import { NORMAL_FAULTS } from "./model.js";
import { ensureSimDir, resetSim, simPaths } from "./paths.js";
import { plan, SCENARIOS, type Action, type Scenario } from "./scenarios.js";
import { FIRST_RELEASE, seedHistory, seedHours } from "./seed.js";
import { killAllNow, Log, NextDemo, NodeDemo, portFree, PORTS, Server, type Demo } from "./stack.js";
import { MIN, type AppKind } from "./traffic.js";
import { mins, storeChecks, timeline, Tracker, type Problem, type Result, type Timeline } from "./verify.js";

const POLL_MS = 5000;
/** A poll this late means the machine slept or the process was stopped. */
const PAUSE_MS = 60_000;

function args(argv: string[]) {
  const out = { command: argv[0] ?? "", names: [] as string[], app: "node" as AppKind, seed: 1 };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--app") {
      const v = argv[++i];
      if (v !== "node" && v !== "next") throw new Error("--app must be node or next");
      out.app = v;
    } else if (a === "--seed") {
      out.seed = Number(argv[++i]);
      if (!Number.isInteger(out.seed)) throw new Error("--seed must be an integer");
    } else out.names.push(a);
  }
  return out;
}

function list(): void {
  for (const app of ["node", "next"] as const) {
    console.log(`\ndemo-${app}:`);
    for (const s of SCENARIOS.filter((x) => x.apps.includes(app))) {
      console.log(`  ${s.name.padEnd(12)} ${s.description}`);
      if (!s.expect.length) console.log(`  ${"".padEnd(12)}   expects no finding`);
      for (const e of s.expect) {
        console.log(`  ${"".padEnd(12)}   ${e.fingerprint} ${e.severity}: shows within ${mins(e.showWithinMs)}, resolves within ${mins(e.resolveWithinMs)} of the fault ending`);
      }
    }
  }
  console.log("\nRun one with `npm run sim -- run <name> [--app next]`, or every one with `npm run sim -- run all` (about 55 min for demo-node).");
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function printReport(results: Result[], problems: Problem[], notes: string[]): boolean {
  console.log("\nResult");
  for (const r of results) {
    const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "OPEN";
    const times = `shown ${r.showMs === undefined ? "-" : mins(r.showMs)}, resolved ${r.resolveMs === undefined ? "-" : mins(r.resolveMs)}`;
    console.log(`  ${mark}  ${r.scenario.padEnd(12)} ${r.fingerprint} (${r.severity}): ${times}${r.status === "pass" ? "" : ` (${r.detail})`}`);
  }
  for (const p of problems) console.log(`  FAIL  ${p.kind}: ${p.detail}`);
  for (const n of notes) console.log(`  note  usage (info, not judged): ${n}`);
  const ok = results.every((r) => r.status === "pass") && !problems.length;
  console.log(ok ? "\nAll expectations met." : "\nSome expectations were not met.");
  return ok;
}

async function run(app: AppKind, names: string[], seed: number): Promise<boolean> {
  if (!names.length) throw new Error("usage: npm run sim -- run <scenario|all> [--app node|next]  (see: npm run sim -- list)");
  const planned = plan(app, names);
  if (app === "next" && !NextDemo.built()) throw new Error("demo-next is not built: run `npm run build -w @abigaail/demo-next` first");
  const liveToken = process.env.ABIGAAIL_LIVE_TOKEN || undefined;
  for (const port of [PORTS.ingest, PORTS[app], ...(liveToken ? [PORTS.live] : [])]) {
    if (!(await portFree(port))) throw new Error(`port ${port} is in use; stop npm run dev:server / demo:${app} first (the simulator runs its own)`);
  }

  // A fresh simulation every time; data/abigaail.db is never opened.
  resetSim();
  const paths = ensureSimDir();
  const log = new Log(paths.log);
  console.log(`Simulating against demo-${app} in data/sim/ (your data/abigaail.db is not touched). Log: data/sim/sim.log`);

  const t0 = Date.now();
  const writable = openStore(paths.db);
  const { app: created, key } = writable.createApp(`sim-${app}`, "sim");
  const hours = seedHours(t0);
  const events = seedHistory(writable, created.id, app, hours, seed);
  writable.checkpoint();
  writable.close();
  console.log(`Seeded ${events} events of history over ${hours.length} past hours in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);

  const server = new Server(paths, log, liveToken);
  const demo: Demo = app === "node" ? new NodeDemo(key, log) : new NextDemo(key, log);
  let driver: Driver | undefined;
  let reader: StoreReader | undefined;
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();
  let t: Timeline | undefined;
  let tracker: Tracker | undefined;

  const shutdown = async () => {
    stopping = true;
    for (const x of timers) clearTimeout(x);
    driver?.stop();
    await demo.stop().catch(() => undefined);
    await server.stop().catch(() => undefined);
  };
  const finish = (): boolean => {
    if (!t || !tracker || !reader) return false;
    const now = Date.now();
    tracker.observe(reader.findingsSince(created.id, t.runStart, 1000));
    const results = tracker.results(now);
    const problems = [...tracker.problems(), ...storeChecks(reader, created.id, t, now, (from, to) => driver!.answered(from, to))];
    const ok = printReport(results, problems, tracker.notes());
    writeFileSync(paths.report, JSON.stringify({ app, appName: created.name, seed, node: process.versions.node, linking: demo.linking, timeline: t, results, problems, stats: driver?.stats }, null, 2));
    return ok;
  };

  let interrupted = false;
  let paused = 0;
  const onSignal = () => {
    if (interrupted) {
      killAllNow();
      process.exit(130);
    }
    interrupted = true;
    console.log("\nStopping (Ctrl-C again to kill at once)…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await server.start();
    reader = openReadOnly(paths.db);
    const bootAfter = Date.now();
    await demo.start(FIRST_RELEASE);
    // The run starts once the demo's boot is stored.
    for (const until = Date.now() + 30_000; (reader.appById(created.id)?.last_event_at ?? 0) < bootAfter; ) {
      if (Date.now() > until) throw new Error("the demo's events did not arrive within 30 s (see data/sim/sim.log)");
      await new Promise((r) => setTimeout(r, 250));
    }

    const runStart = Date.now();
    t = timeline(runStart, planned);
    tracker = new Tracker(t);
    driver = new Driver(demo.url, app, seed);
    driver.start();
    const lastFaultEnd = Math.max(...planned.map((p) => runStart + p.at + p.scenario.faultMs));
    const deadline = Math.max(lastFaultEnd, ...t.items.map((i) => i.faultEndAt + i.exp.resolveWithinMs)) + 2 * MIN;
    console.log(`Node ${process.versions.node}; outbound linking ${demo.linking}.`);
    console.log(`Started at ${new Date(runStart).toISOString().slice(11, 19)} UTC. Expected end by ${new Date(deadline).toISOString().slice(11, 19)} UTC at the latest.`);

    // Steps run one at a time, in order (a start never overlaps a kill).
    let chain = Promise.resolve();
    let faults: Faults = { ...NORMAL_FAULTS };
    let release = FIRST_RELEASE;
    const apply = async (a: Action) => {
      if ("faults" in a) await demo.setFaults((faults = { ...faults, ...a.faults }));
      else if ("humans" in a) driver!.mode = { ...driver!.mode, humans: a.humans };
      else if ("bots" in a) driver!.mode = { ...driver!.mode, bots: a.bots };
      else if ("extra" in a) driver!.mode = { ...driver!.mode, extra: a.extra };
      else if ("kill" in a) await demo.kill();
      else if ("stop" in a) await demo.stop();
      else if ("start" in a) await demo.start((release = a.start.release ?? release));
      else if ("supervise" in a) demo.supervise(a.supervise);
    };
    const announce = (s: Scenario, at: number) => () => console.log(`\n${clock(at)}  ${s.name}: ${s.description}`);
    for (const { scenario: s, at } of planned) {
      const x = setTimeout(announce(s, at), at);
      timers.add(x);
      for (const step of s.steps) {
        const timer = setTimeout(() => {
          chain = chain.then(() => apply(step.action)).catch((err: unknown) => {
            console.log(`  step failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }, at + step.at);
        timers.add(timer);
      }
    }

    const shown = new Map<string, string>();
    let lastPoll = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (interrupted) break;
      const now = Date.now();
      // Timings mean nothing once the machine slept or the process was paused.
      if (now - lastPoll > PAUSE_MS) {
        paused = now - lastPoll;
        console.log(`\nThe run was paused for ${mins(paused)} (the machine slept, or the process was stopped); stopping, its timings are not meaningful.`);
        break;
      }
      lastPoll = now;
      tracker.observe(reader.findingsSince(created.id, runStart, 1000));
      for (const r of tracker.results(now)) {
        const k = `${r.scenario} ${r.fingerprint}`;
        if (shown.get(k) === r.status || r.status === "waiting") continue;
        shown.set(k, r.status);
        const what = r.status === "shown" ? `opened (${r.severity}) after ${mins(r.showMs ?? 0)}` : r.status === "pass" ? `resolved ${mins(r.resolveMs ?? 0)} after its fault ended` : `FAILED: ${r.detail}`;
        console.log(`${clock(now - runStart)}    ${r.fingerprint} ${what}`);
      }
      const countsDone = t.countWindows.every((w) => now > w.to + MIN);
      if ((now > lastFaultEnd + 2 * MIN && countsDone && tracker.settled(now)) || now > deadline) break;
    }
    await shutdown();
    if (paused) {
      console.log("Not judged. Keep the machine awake and run it again, e.g. systemd-inhibit npm run sim -- run all");
      return false;
    }
    return finish() && !interrupted;
  } finally {
    if (!stopping) await shutdown();
    reader?.close();
    await log.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function verify(): boolean {
  const paths = simPaths();
  if (!existsSync(paths.report)) throw new Error("no previous run in data/sim/ (npm run sim -- run <scenario>)");
  const report = JSON.parse(readFileSync(paths.report, "utf8")) as { app: AppKind; appName: string; timeline: Timeline };
  const reader = openReadOnly(paths.db);
  try {
    const app = reader.appByName(report.appName);
    if (!app) throw new Error(`no app ${report.appName} in data/sim/`);
    const tracker = new Tracker(report.timeline);
    tracker.observe(reader.findingsSince(app.id, report.timeline.runStart, 1000));
    console.log("Judged from the findings as stored now (severities seen only while a run polls are not available here).");
    return printReport(tracker.results(Date.now()), tracker.problems(), tracker.notes());
  } finally {
    reader.close();
  }
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  switch (a.command) {
    case "list":
      list();
      return 0;
    case "reset":
      console.log(`Deleted ${resetSim()}`);
      return 0;
    case "verify":
      return verify() ? 0 : 1;
    case "run":
      return (await run(a.app, a.names, a.seed)) ? 0 : 1;
    default:
      console.log("usage: npm run sim -- list | run <scenario|all> [--app node|next] [--seed n] | verify | reset");
      return a.command ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
