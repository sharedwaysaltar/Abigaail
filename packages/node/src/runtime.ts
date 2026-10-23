// Runtime signals for the Resilience agent (DECISIONS #110-#114): the post-GC
// heap floor, which route was running when the event loop blocked, how long
// the process took to start, and (opt-in) how the previous process ended.
//
// Everything here is O(1) per event, bounded, and guarded: it never throws into
// the app. Nothing new is sent until the server has announced runtime_v1, so
// against an older server the payload is exactly what it was before.

import { createHmac } from "node:crypto";
import cluster from "node:cluster";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants as perfConstants, performance, PerformanceObserver } from "node:perf_hooks";
import v8 from "node:v8";
import type { ServerResponse } from "node:http";
import { cleanPrevExit, type AbigaailClient } from "@abigaail/core";
import type { MetricName, PrevExit, StackFrame } from "@abigaail/schema";

export const RUNTIME = {
  /** Drift timer period. A tick this much later than due is a block. */
  tickMs: 50,
  blockMinMs: 100,
  /** A suspect that finished within this long after a block, having run through it, is the strong suspect. */
  settleMs: 50,
  /** A request that has sent headers and been open this long (SSE, streaming, upgrades) is never a suspect. */
  streamingMs: 5_000,
  /** In-flight entries older than this are dropped, whatever their state. */
  inflightTtlMs: 10 * 60_000,
  maxInflight: 1_000,
  /** Recently finished requests kept for a block detected just after its blocker finished. */
  maxRecent: 64,
  /** Blocks waiting for their strong suspect to finish. */
  maxPendingBlocks: 64,
  /** Distinct routes charged per interval; block events sent per interval (plus "no request"). */
  maxBlockKeys: 100,
  blockEventsPerInterval: 5,
  /** In-flight entries are swept for closed or aborted responses this often. */
  sweepMs: 1_000,
  /** ready waits this long for the server to announce runtime_v1, then is dropped. */
  readyHoldMs: 5 * 60_000,
  /** Without a listening server, ready is sent this long after init (no startup_ms). */
  readyFallbackMs: 60_000,
  /** The first request counts as "started" only this soon after init. */
  firstRequestStartupMs: 60_000,
  maxRecordBytes: 1_024,
  /** Orphaned crash records (another instance's, e.g. a replaced cluster worker) are removed after this long. */
  orphanRecordMs: 7 * 86_400_000,
  maxOrphanScan: 200,
} as const;

const FEATURE = "runtime_v1";
const MB = 1048576;
const RECORD_RE = /^abigaail-exit-[0-9a-f]{12}\.json$/;
const round = (n: number) => Math.round(n * 100) / 100;

interface Inflight {
  start: number;
  path: string;
  /** Final route and end time, set when the response finishes. */
  route?: string;
  end?: number;
}

interface PendingBlock {
  end: number;
  ms: number;
  suspects: Inflight[];
}

export interface RuntimeOptions {
  /** HMAC key for the instance id (the ingest key: the id cannot be computed without it). */
  instanceKey: string;
  env: NodeJS.ProcessEnv;
  /** Directory for the crash record; undefined = off. */
  crashRecordDir?: string | undefined;
  /** Route of an in-flight path, without counting it against the route cap. */
  peekRoute: (path: string) => string;
  /** Clock (tests); default performance.now, which counts from process start. */
  now?: () => number;
  /** Tests drive tick() themselves; no timer is started. */
  manualTick?: boolean;
}

/** Opaque, stable per host + process-manager slot + cluster worker; 12 hex. */
export function instanceId(key: string, env: NodeJS.ProcessEnv): string {
  const worker = cluster.isWorker && cluster.worker ? String(cluster.worker.id) : "";
  const identity = ["abigaail-instance", os.hostname(), env.NODE_APP_INSTANCE ?? "", worker].join("\0");
  return createHmac("sha256", key).update(identity).digest("hex").slice(0, 12);
}

/** The container memory limit in MB, when the process has one. */
function memoryLimitMb(): number | undefined {
  const limit = (process as { constrainedMemory?: () => number }).constrainedMemory?.();
  // 0 or a 64-bit "max" means no limit.
  return typeof limit === "number" && limit > 0 && limit < 2 ** 52 ? round(limit / MB) : undefined;
}

export class RuntimeMonitor {
  readonly instance: string;
  private readonly inflight = new Map<ServerResponse, Inflight>();
  /** Ring of the latest finished requests: a synchronous handler finishes before the late tick sees the block. */
  private readonly recent: Inflight[] = [];
  private readonly pending: PendingBlock[] = [];
  private readonly charged = new Map<string, { count: number; total: number; max: number }>();
  private readonly now: () => number;
  private readonly startedAt: number;
  private lastTick: number;
  private lastSweep: number;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly gc: PerformanceObserver | undefined;
  private floor: number | undefined;
  /** Distinct blocks this interval (a block split between routes counts once). */
  private blocks = 0;
  private majors = 0;
  private pauseMs = 0;
  private startupMs: number | undefined;
  private ready: { boot_id: string; prev_exit?: PrevExit } | undefined;
  private readySent = false;
  private readonly recordFile: string | undefined;
  private fatal: { error_type: string; frame?: StackFrame } | undefined;
  private readonly onExit = (code: unknown) => this.writeRecord(code);
  private stopped = false;

  constructor(
    private readonly client: AbigaailClient,
    private readonly report: (err: unknown) => void,
    private readonly opts: RuntimeOptions,
    warn: (msg: string) => void,
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.startedAt = this.lastTick = this.lastSweep = this.now();
    this.instance = instanceId(opts.instanceKey, opts.env);
    this.gc = this.observeGc();
    this.recordFile = this.recordPath(opts.crashRecordDir, warn);
    if (this.recordFile) process.on("exit", this.onExit);
    if (!opts.manualTick) {
      this.timer = setInterval(() => this.guard(() => this.tick()), RUNTIME.tickMs);
      // Never keep the host process alive for telemetry.
      this.timer.unref();
    }
  }

  /** True once the server announced runtime_v1. */
  private get on(): boolean {
    return this.client.features()?.has(FEATURE) === true;
  }

  /** `{instance}` for heartbeat and shutdown, only once the server takes it. */
  instanceField(): { instance?: string } {
    return this.on ? { instance: this.instance } : {};
  }

  private guard(fn: () => void): void {
    try {
      if (!this.stopped) fn();
    } catch (err) {
      this.report(err);
    }
  }

  // GC floor ----------------------------------------------------------------

  private observeGc(): PerformanceObserver | undefined {
    try {
      const obs = new PerformanceObserver((list) =>
        this.guard(() => {
          for (const e of list.getEntries()) {
            this.pauseMs += e.duration;
            const kind = (e as { detail?: { kind?: number } }).detail?.kind;
            if (kind !== perfConstants.NODE_PERFORMANCE_GC_MAJOR) continue;
            this.majors++;
            // Read right after a full collection: what is still alive is the floor.
            const used = v8.getHeapStatistics().used_heap_size / MB;
            if (this.floor === undefined || used < this.floor) this.floor = used;
          }
        }),
      );
      obs.observe({ entryTypes: ["gc"] });
      return obs;
    } catch (err) {
      this.report(err);
      return undefined;
    }
  }

  // In-flight requests and blocks -------------------------------------------

  requestStart(response: ServerResponse, path: string): void {
    if (this.inflight.size >= RUNTIME.maxInflight) return;
    this.inflight.set(response, { start: this.now(), path: path.slice(0, 2048) });
  }

  requestFinish(response: ServerResponse, route: string): void {
    const entry = this.inflight.get(response);
    if (!entry) return;
    this.inflight.delete(response);
    entry.route = route;
    entry.end = this.now();
    if (this.recent.length >= RUNTIME.maxRecent) this.recent.shift();
    this.recent.push(entry);
  }

  /** Entries still tracked (tests). */
  get inflightSize(): number {
    return this.inflight.size;
  }

  /** One drift-timer tick (every RUNTIME.tickMs). */
  tick(): void {
    const now = this.now();
    const due = this.lastTick + RUNTIME.tickMs;
    const late = now - due;
    this.lastTick = now;
    if (late >= RUNTIME.blockMinMs) this.block(now, late);
    this.settle(now);
    if (now - this.lastSweep >= RUNTIME.sweepMs) {
      this.lastSweep = now;
      this.sweep(now);
      this.recent.length = 0;
      this.maybeReady(now);
    }
  }

  /**
   * The loop was blocked for `ms` until `end`. Nothing can start while it is
   * blocked, so every request in flight now was there when the blocking work
   * began (the blocker itself may have started just after the timer was due,
   * in the poll phase), and so was one that finished inside the window. All
   * are suspects, except long-open streams: an SSE connection is "in flight"
   * through every block without causing any.
   */
  private block(end: number, ms: number): void {
    this.blocks++;
    const suspects: Inflight[] = [];
    for (const [res, entry] of this.inflight) {
      if (res.headersSent && end - entry.start > RUNTIME.streamingMs) continue;
      suspects.push(entry);
    }
    // A request that finished inside the block window was running when it ended: usually the blocker.
    const began = end - ms - RUNTIME.tickMs;
    for (const entry of this.recent) {
      if (entry.end !== undefined && entry.end >= began && entry.end - entry.start <= RUNTIME.streamingMs) suspects.push(entry);
    }
    if (this.pending.length >= RUNTIME.maxPendingBlocks) this.pending.shift();
    this.pending.push({ end, ms, suspects });
  }

  /**
   * A block is charged once its strong suspect had time to finish: a request
   * that ran through the block and finished right after it did the blocking
   * work. Otherwise the block is split evenly between the suspects.
   */
  private settle(now: number): void {
    while (this.pending.length && now - this.pending[0]!.end >= RUNTIME.settleMs) {
      const b = this.pending.shift()!;
      const strong = b.suspects.filter(
        (s) => s.end !== undefined && s.end <= b.end + RUNTIME.settleMs && s.end - s.start >= 0.9 * b.ms,
      );
      const blamed = strong.length ? strong : b.suspects;
      if (!blamed.length) {
        this.charge("", b.ms, b.ms);
        continue;
      }
      for (const s of blamed) this.charge(s.route ?? this.opts.peekRoute(s.path), b.ms / blamed.length, b.ms);
    }
  }

  private charge(route: string, ms: number, blockMs: number): void {
    let c = this.charged.get(route);
    if (!c) {
      if (this.charged.size >= RUNTIME.maxBlockKeys) return;
      this.charged.set(route, (c = { count: 0, total: 0, max: 0 }));
    }
    c.count++;
    c.total += ms;
    c.max = Math.max(c.max, blockMs);
  }

  /** Closed, aborted and stale entries go, so the table cannot fill with dead requests. */
  private sweep(now: number): void {
    for (const [res, entry] of this.inflight) {
      if (res.destroyed || res.writableFinished || now - entry.start > RUNTIME.inflightTtlMs) this.inflight.delete(res);
    }
  }

  // Metrics -------------------------------------------------------------------

  /** Called with the adapter's metrics; sends runtime metrics and block events once the server takes them. */
  sample(mem: NodeJS.MemoryUsage, metric: (name: MetricName, value: number) => void): void {
    const floor = this.floor;
    const majors = this.majors;
    const pause = this.pauseMs;
    const blocks = this.blocks;
    this.blocks = 0;
    this.floor = undefined;
    this.majors = 0;
    this.pauseMs = 0;
    const charged = [...this.charged];
    this.charged.clear();
    if (!this.on) return;
    if (floor !== undefined) metric("heap_floor_mb", floor);
    metric("gc_major_count", majors);
    metric("gc_pause_ms", pause);
    metric("event_loop_blocks", blocks);
    metric("memory_external_mb", mem.external / MB);
    metric("memory_array_buffers_mb", mem.arrayBuffers / MB);
    const none = charged.find(([route]) => route === "");
    const top = charged
      .filter(([route]) => route !== "")
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, RUNTIME.blockEventsPerInterval);
    for (const [route, c] of none ? [...top, none] : top) {
      this.client.capture({
        type: "block",
        ...(route ? { route } : {}),
        count: c.count,
        total_ms: round(c.total),
        max_ms: round(c.max),
      });
    }
  }

  // Startup and ready ---------------------------------------------------------

  /** The boot event's id, and the previous process's crash record if there is one. */
  booted(bootId: string): void {
    const prev = this.readRecord();
    this.ready = { boot_id: bootId, ...(prev ? { prev_exit: prev } : {}) };
  }

  /** The first server is listening (or, without that signal, the first request arrived). */
  listening(source: "listen" | "request"): void {
    if (this.startupMs !== undefined) return;
    const now = this.now();
    if (source === "request" && now - this.startedAt > RUNTIME.firstRequestStartupMs) {
      this.startupMs = -1;
      return;
    }
    // performance.now() counts from process start, so this includes loading the app.
    this.startupMs = now;
    this.maybeReady(now);
  }

  private maybeReady(now: number): void {
    if (this.readySent || !this.ready) return;
    const features = this.client.features();
    if (features && !features.has(FEATURE)) return this.dropReady();
    if (!features) {
      if (now - this.startedAt > RUNTIME.readyHoldMs) this.dropReady();
      return;
    }
    // Wait for the first server to listen, up to a minute; a worker without one sends no startup time.
    if (this.startupMs === undefined && now - this.startedAt < RUNTIME.readyFallbackMs) return;
    const startup = this.startupMs !== undefined && this.startupMs >= 0 ? this.startupMs : undefined;
    const heapLimit = v8.getHeapStatistics().heap_size_limit / MB;
    const memLimit = memoryLimitMb();
    this.readySent = true;
    this.client.capture({
      type: "lifecycle",
      kind: "ready",
      instance: this.instance,
      boot_id: this.ready.boot_id,
      ...(startup !== undefined ? { startup_ms: round(startup) } : {}),
      heap_limit_mb: round(heapLimit),
      ...(memLimit !== undefined ? { memory_limit_mb: memLimit } : {}),
      ...(this.ready.prev_exit ? { prev_exit: this.ready.prev_exit } : {}),
    });
    this.ready = undefined;
  }

  private dropReady(): void {
    this.readySent = true;
    this.ready = undefined;
  }

  // Crash record (opt-in) -----------------------------------------------------

  private recordPath(dir: string | undefined, warn: (msg: string) => void): string | undefined {
    if (!dir) return undefined;
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
    } catch {
      warn("ABIGAAIL_CRASH_RECORD_DIR is not an existing directory; crash records are off");
      return undefined;
    }
    this.removeOrphans(dir);
    return path.join(dir, `abigaail-exit-${this.instance}.json`);
  }

  /** Records of instances that never came back (e.g. a replaced cluster worker), after a week. */
  private removeOrphans(dir: string): void {
    try {
      const names = fs.readdirSync(dir).filter((n) => RECORD_RE.test(n)).slice(0, RUNTIME.maxOrphanScan);
      const now = Date.now();
      for (const name of names) {
        const file = path.join(dir, name);
        const st = fs.lstatSync(file);
        if (st.isFile() && now - st.mtimeMs > RUNTIME.orphanRecordMs) fs.unlinkSync(file);
      }
    } catch (err) {
      this.report(err);
    }
  }

  /** Read and delete this instance's record. A symlink, a non-file or anything oversized is ignored. */
  private readRecord(): PrevExit | undefined {
    const file = this.recordFile;
    if (!file) return undefined;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > RUNTIME.maxRecordBytes) return undefined;
      const buf = Buffer.alloc(st.size);
      const n = fs.readSync(fd, buf, 0, st.size, 0);
      fs.closeSync(fd);
      fd = undefined;
      fs.unlinkSync(file);
      const raw: unknown = JSON.parse(buf.subarray(0, n).toString("utf8"));
      return (raw as { v?: unknown } | null)?.v === 1 ? cleanPrevExit(raw) : undefined;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") this.report(err);
      return undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /** The uncaught error that is about to end the process (from uncaughtExceptionMonitor). */
  fatalError(errorType: string, frame: StackFrame | undefined): void {
    this.fatal = { error_type: errorType, ...(frame ? { frame } : {}) };
  }

  /**
   * process 'exit': synchronous, a few hundred bytes, and it cannot delay or
   * change the exit. A kill by signal or out of memory never gets here, which
   * is itself the answer the next boot reports ("no record").
   */
  private writeRecord(code: unknown): void {
    try {
      const file = this.recordFile;
      if (!file || this.stopped) return;
      const exit = Number.isInteger(code) ? (code as number) & 0xff : 0;
      const record = {
        v: 1,
        code: exit,
        // An error the app survived (an uncaughtException handler) did not end it.
        ...(exit !== 0 && this.fatal ? this.fatal : {}),
        heap_mb: round(v8.getHeapStatistics().used_heap_size / MB),
        uptime_s: Math.floor(process.uptime()),
      };
      const text = JSON.stringify({ v: 1, ...(cleanPrevExit(record) ?? { code: exit }) });
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, text.slice(0, 512));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Exiting: nothing to report to.
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.gc?.disconnect();
    process.off("exit", this.onExit);
    this.inflight.clear();
    this.recent.length = 0;
    this.pending.length = 0;
  }
}
