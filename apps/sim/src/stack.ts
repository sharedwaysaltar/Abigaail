// The processes a live run owns: an ingest server on the simulator's own
// database, and one demo app. Children get an explicit environment (nothing
// inherited from the shell, no .env files read by us), their output is
// redacted and written to data/sim/sim.log, and they are stopped on exit.

import { fork, spawn, type ChildProcess } from "node:child_process";
import { defaultLinkOutbound } from "@abigaail/node";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assertLocalTarget } from "./guard.js";
import type { Faults } from "./model.js";
import { NORMAL_FAULTS } from "./model.js";
import { REPO_ROOT, type SimPaths } from "./paths.js";
import type { AppKind } from "./traffic.js";

export const PORTS = { ingest: 4318, live: 4320, node: 3001, next: 3000 } as const;
export const SERVER_MAIN = join(REPO_ROOT, "apps/server/dist/main.js");
export const DEMO_NODE_MAIN = join(REPO_ROOT, "apps/demo-node/server.mjs");
export const DEMO_NEXT_DIR = join(REPO_ROOT, "apps/demo-next");
export const REGION = "LON1";

/** Ingest keys never reach the log, the terminal or the report, even if a child prints one. */
export function redact(text: string): string {
  return text.replace(/abk_[A-Za-z0-9_-]+/g, "abk_[redacted]");
}

export class Log {
  private readonly out: WriteStream;
  constructor(path: string) {
    this.out = createWriteStream(path, { flags: "a", mode: 0o600 });
  }
  write(source: string, line: string): void {
    this.out.write(`${new Date().toISOString()} [${source}] ${redact(line)}\n`);
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.out.end(resolve));
  }
}

function capture(child: ChildProcess, source: string, log: Log): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) createInterface({ input: stream }).on("line", (line) => log.write(source, line));
  }
}

/** True when nothing listens on 127.0.0.1:port. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

export async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, "127.0.0.1");
      c.once("connect", () => (c.destroy(), resolve(true)));
      c.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > until) throw new Error(`nothing listens on 127.0.0.1:${port} after ${timeoutMs / 1000} s (see data/sim/sim.log)`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** Signal, then SIGKILL after `graceMs` if still running. */
async function terminate(child: ChildProcess, signal: NodeJS.Signals, graceMs: number, group = false): Promise<void> {
  const send = (sig: NodeJS.Signals) => {
    try {
      if (group && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) return;
  send(signal);
  const timer = setTimeout(() => send("SIGKILL"), graceMs);
  await exited(child);
  clearTimeout(timer);
}

const live = new Set<{ child: ChildProcess; group: boolean }>();
/** Last resort: never leave a child running when the simulator exits. */
export function killAllNow(): void {
  for (const { child, group } of live) {
    try {
      if (group && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
process.on("exit", killAllNow);

function track(child: ChildProcess, group = false): ChildProcess {
  const entry = { child, group };
  live.add(entry);
  child.once("exit", () => live.delete(entry));
  return child;
}

/** The base environment for children: only what a Node process needs to run. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "TZ"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export class Server {
  private child: ChildProcess | undefined;

  constructor(
    private readonly paths: SimPaths,
    private readonly log: Log,
    private readonly liveToken: string | undefined,
  ) {}

  async start(): Promise<void> {
    if (!existsSync(SERVER_MAIN)) throw new Error("apps/server is not built; run it through `npm run sim`, which builds first");
    const env = {
      ...baseEnv(),
      ABIGAAIL_DB_PATH: this.paths.db,
      ABIGAAIL_SALT_PATH: this.paths.salt,
      ABIGAAIL_AUTH_DB_PATH: this.paths.authDb,
      ABIGAAIL_HOST: "127.0.0.1",
      ABIGAAIL_PORT: String(PORTS.ingest),
      ABIGAAIL_LIVE_PORT: String(PORTS.live),
      ...(this.liveToken ? { ABIGAAIL_LIVE_TOKEN: this.liveToken } : {}),
    };
    this.child = track(spawn(process.execPath, [SERVER_MAIN], { env, stdio: ["ignore", "pipe", "pipe"] }));
    capture(this.child, "server", this.log);
    await waitForPort(PORTS.ingest, 20_000);
  }

  stop(): Promise<void> {
    return this.child ? terminate(this.child, "SIGINT", 8000) : Promise.resolve();
  }
}

export interface Demo {
  readonly app: AppKind;
  readonly url: URL;
  /** Whether the demo's SDK links outbound calls to requests, and why. */
  readonly linking: string;
  start(release: string): Promise<void>;
  /** SIGKILL: no shutdown event; queued events are lost. */
  kill(): Promise<void>;
  /** Clean stop. */
  stop(): Promise<void>;
  setFaults(f: Faults): Promise<void>;
  /** Restart the demo 2 s after it dies on its own (never after our kill or stop). */
  supervise(on: boolean): void;
}

/** A supervisor's restart delay (as systemd's RestartSec or pm2 would wait). */
export const RESTART_AFTER_MS = 2_000;

/** demo-node, forked with an IPC channel for its fault switches. */
export class NodeDemo implements Demo {
  readonly app = "node" as const;
  readonly url = assertLocalTarget(`http://127.0.0.1:${PORTS.node}/`);
  /** demo-node forces it on when ABIGAAIL_DEMO_SIM=1 (apps/demo-node/server.mjs). */
  readonly linking = "on (forced by the simulator)";
  readonly #key: string;
  private child: ChildProcess | undefined;
  private faults: Faults = NORMAL_FAULTS;
  private supervising = false;
  private release = "";

  constructor(key: string, private readonly log: Log) {
    this.#key = key;
  }

  supervise(on: boolean): void {
    this.supervising = on;
  }

  async start(release: string): Promise<void> {
    this.release = release;
    const endpoint = assertLocalTarget(`http://127.0.0.1:${PORTS.ingest}/ingest`);
    const env = {
      ...baseEnv(),
      ABIGAAIL_ENDPOINT: endpoint.href,
      ABIGAAIL_INGEST_KEY: this.#key,
      ABIGAAIL_RELEASE: release,
      ABIGAAIL_ENVIRONMENT: "development",
      ABIGAAIL_REGION: REGION,
      ABIGAAIL_DEMO_SIM: "1",
      // Profiling on, so findings can name renderDocs and rememberSearch (DECISIONS #120).
      ABIGAAIL_PROFILING: "1",
      PORT: String(PORTS.node),
    };
    const child = track(fork(DEMO_NODE_MAIN, [], { env, silent: true, execArgv: [] }));
    this.child = child;
    capture(child, "demo-node", this.log);
    child.once("exit", (code, signal) => {
      // Our own kill and stop clear this.child first; anything else died on its own.
      if (this.child !== child) return;
      this.child = undefined;
      this.log.write("sim", `demo-node exited on its own (${signal ?? `code ${code}`})${this.supervising ? `; restarting in ${RESTART_AFTER_MS / 1000} s` : ""}`);
      if (!this.supervising) return;
      setTimeout(() => {
        if (!this.child && this.supervising) this.start(this.release).catch((err: unknown) => this.log.write("sim", `restart failed: ${err instanceof Error ? err.message : String(err)}`));
      }, RESTART_AFTER_MS);
    });
    await waitForPort(PORTS.node, 15_000);
    if (this.faults !== NORMAL_FAULTS) await this.send();
  }

  async kill(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) await terminate(child, "SIGKILL", 0);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) await terminate(child, "SIGINT", 5000);
  }

  async setFaults(f: Faults): Promise<void> {
    this.faults = f;
    await this.send();
  }

  private send(): Promise<void> {
    const child = this.child;
    if (!child?.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (child.off("message", onMessage), reject(new Error("demo-node did not acknowledge the fault switch"))), 3000);
      const onMessage = (m: unknown) => {
        if ((m as { type?: string })?.type !== "faults-applied") return;
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve();
      };
      child.on("message", onMessage);
      child.send({ type: "faults", faults: this.faults });
    });
  }
}

/** demo-next via `next start` from its existing build, in its own process group. */
export class NextDemo implements Demo {
  readonly app = "next" as const;
  readonly url = assertLocalTarget(`http://127.0.0.1:${PORTS.next}/`);
  readonly linking = `${defaultLinkOutbound(process.versions.node) ? "on" : "off"} (the SDK's default on Node ${process.versions.node})`;
  readonly #key: string;
  private child: ChildProcess | undefined;

  constructor(key: string, private readonly log: Log) {
    this.#key = key;
  }

  static built(): boolean {
    return existsSync(join(DEMO_NEXT_DIR, ".next", "BUILD_ID"));
  }

  async start(release: string): Promise<void> {
    const nextBin = createRequire(join(DEMO_NEXT_DIR, "package.json")).resolve("next/dist/bin/next");
    const endpoint = assertLocalTarget(`http://127.0.0.1:${PORTS.ingest}/ingest`);
    // Our values win over any apps/demo-next/.env: Next never overrides variables already set.
    const env = {
      ...baseEnv(),
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      ABIGAAIL_ENDPOINT: endpoint.href,
      ABIGAAIL_INGEST_KEY: this.#key,
      ABIGAAIL_RELEASE: release,
      ABIGAAIL_ENVIRONMENT: "development",
      ABIGAAIL_REGION: REGION,
    };
    this.child = track(
      spawn(process.execPath, [nextBin, "start", "-p", String(PORTS.next), "-H", "127.0.0.1"], { cwd: DEMO_NEXT_DIR, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
      true,
    );
    capture(this.child, "demo-next", this.log);
    await waitForPort(PORTS.next, 30_000);
  }

  async kill(): Promise<void> {
    if (this.child) await terminate(this.child, "SIGKILL", 0, true);
  }

  async stop(): Promise<void> {
    if (this.child) await terminate(this.child, "SIGTERM", 8000, true);
  }

  async setFaults(f: Faults): Promise<void> {
    if (f.dependency !== "ok" || f.slowSearch || f.userErrorShare > 0 || f.leakPerRequest > 0 || f.leakPerSecond > 0 || f.blockDocs || f.oomKillMb > 0) {
      throw new Error("demo-next has no fault switches");
    }
  }

  supervise(on: boolean): void {
    if (on) throw new Error("demo-next runs no supervisor");
  }
}
