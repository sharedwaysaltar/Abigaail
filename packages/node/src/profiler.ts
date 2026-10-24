// Continuous profiling (DECISIONS #118-#121). Opt-in: `profiling: true` or
// ABIGAAIL_PROFILING=1; ABIGAAIL_PROFILING=off always wins. In-process
// node:inspector, duty-cycled CPU windows (20 s every 5 minutes at 10 ms) and a
// sampling heap profiler (one sample per 512 KiB allocated). Starting a CPU
// profile pauses the app while V8 records its compiled code (measured: 19 ms
// in an empty process, 37-54 ms with Next.js loaded), so windows are rare and
// that pause is measured and budgeted too. Only function
// names, project-relative paths and line numbers leave the app, with the same
// rules as stack frames: never values, strings, closures or source.
//
// Bounded and fail-open: every window's main-thread work is measured; over the
// budget, or while the app is loaded, windows are skipped with a growing gap,
// and after three overruns profiling is off for the life of the process. Any
// inspector error turns profiling off, never the SDK.

import { performance } from "node:perf_hooks";
import type { AbigaailClient } from "@abigaail/core";
import { isFramePath, isIdent, LIMITS, MAX_FN_LENGTH, type ProfileEvent, type ProfileFrame, type ProfileKind } from "@abigaail/schema";
import { RUNTIME, type RuntimeMonitor, type WindowLog } from "./runtime.js";
import { relativePath } from "./stack.js";

export const PROFILING = {
  /** V8 sampling interval, µs. */
  samplingIntervalUs: 10_000,
  /** A CPU window, and the time between window starts while nothing is wrong. */
  windowMs: 20_000,
  everyMs: 5 * 60_000,
  /** CPU profiles are merged over this long, then sent. */
  sendEveryMs: 5 * 60_000,
  /** Sampling heap profiler: one sample per this many bytes allocated. */
  heapSamplingBytes: 512 * 1024,
  /** Heap profiles every heapEveryMs; more often just after the start (a process that dies young still names its sites). */
  heapEveryMs: 5 * 60_000,
  heapEarlyEveryMs: 2 * 60_000,
  heapEarlyForMs: 10 * 60_000,
  heapSites: 50,
  heapDepth: 8,
  /** Route profiles per send: the busiest, with enough samples. */
  maxRoutes: 5,
  minRouteSamples: 50,
  /**
   * A window starts only when no request is in flight (the start pauses the
   * app): checked this often, for at most this long, else the window is skipped.
   */
  idleRetryMs: 1_000,
  idleWaitMs: 60_000,
  /**
   * After a block, a CPU window at the next idle moment, so the function
   * behind a short incident is sampled (owner's fix after the 10b test): only
   * if no window started in the last blockWindowAfterMs, and at most one such
   * extra window per blockWindowAfterMs.
   */
  blockWindowAfterMs: 5 * 60_000,
  /** Main-thread work allowed per window: starting the profile (V8 records its code), then stop, parse and merge. */
  startBudgetMs: 60,
  budgetMs: 20,
  maxOverruns: 3,
  maxGapMs: 30 * 60_000,
  /** Windows are skipped while the app is this loaded. */
  lagLimitMs: 100,
  cpuLimitPercent: 80,
  /** Distinct stacks kept per profile between sends; more are counted, not kept. */
  maxStacksKept: 2_000,
} as const;

export type ProfilerState = 0 | 1 | 2 | 3;
/** profiler_state values. */
export const PROFILER_STATE = { off: 0, on: 1, backingOff: 2, disabled: 3 } as const;

/** The part of node:inspector's Session the profiler uses (injectable for tests). */
export interface InspectorSession {
  connect(): void;
  post(method: string, params: object | undefined, callback: (err: Error | null, result?: unknown) => void): void;
  disconnect(): void;
}
export interface InspectorModule {
  Session: new () => InspectorSession;
}

/** Whether profiling is on: the kill switch first, then the option, then the variable. */
export function profilingWanted(option: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  const v = env.ABIGAAIL_PROFILING?.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  return option ?? (v === "1" || v === "on" || v === "true");
}

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface CpuNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}
interface CpuProfile {
  nodes: CpuNode[];
  startTime: number;
  samples?: number[];
  timeDeltas?: number[];
}
interface HeapNode {
  callFrame: CallFrame;
  selfSize: number;
  children?: HeapNode[];
}

const IDLE = Symbol("idle");

/**
 * The SDK's own code: the directory this module was loaded from (dist/, or
 * src/ in tests), those of @abigaail/core and @abigaail/schema, and any
 * installed @abigaail package. Its frames are
 * grouped as "(abigaail)", so they never crowd the app's functions or get
 * named as a cause (owner's fix after the 10b test).
 */
const OWN_DIRS: readonly string[] = (() => {
  const dirs: string[] = [];
  try {
    dirs.push(new URL(".", import.meta.url).href);
    for (const m of ["@abigaail/core", "@abigaail/schema"]) {
      try {
        dirs.push(new URL(".", import.meta.resolve(m)).href);
      } catch {
        // Not resolvable here (bundled, or a test runner): the node_modules rule still applies.
      }
    }
  } catch {
    // No import.meta.url: only the node_modules rule.
  }
  return dirs;
})();

export function isSdkUrl(url: string): boolean {
  return url.includes("/node_modules/@abigaail/") || OWN_DIRS.some((d) => url.startsWith(d));
}
const frameKey = (f: ProfileFrame) => `${f.file}:${f.line}:${f.fn ?? ""}`;

/**
 * A V8 call frame as a profile frame: the stack-frame rules (relative path,
 * identifier), or a fixed placeholder ("(abigaail)" for the SDK's own code).
 * Nothing else of the frame is kept.
 */
export function profileFrame(cf: CallFrame, root: string): ProfileFrame | typeof IDLE | undefined {
  const name = cf.functionName;
  if (name === "(root)") return undefined;
  if (name === "(idle)") return IDLE;
  if (name === "(program)") return { file: "(program)", line: 0 };
  if (name === "(garbage collector)") return { file: "(gc)", line: 0 };
  if (cf.url && isSdkUrl(cf.url)) return { file: "(abigaail)", line: 0 };
  const fn = isIdent(name, MAX_FN_LENGTH) ? name : undefined;
  let file = !cf.url ? "(native)" : cf.url.startsWith("node:") ? "(node)" : (relativePath(cf.url, root) ?? "(external)");
  if (!isFramePath(file)) file = "(external)";
  const placeholder = file.startsWith("(");
  return { file, line: placeholder ? 0 : Math.max(0, cf.lineNumber + 1), ...(fn ? { fn } : {}) };
}

/** Merged stacks for one profile between sends. */
class Acc {
  samples = 0;
  concurrent = 0;
  idle = 0;
  windowMs = 0;
  readonly frames = new Map<string, ProfileFrame>();
  readonly stacks = new Map<string, { keys: string[]; weight: number }>();

  add(stack: ProfileFrame[], weight: number): void {
    this.samples += weight;
    const keys = stack.map((f) => {
      const k = frameKey(f);
      if (!this.frames.has(k)) this.frames.set(k, f);
      return k;
    });
    const id = keys.join("|");
    const s = this.stacks.get(id);
    if (s) s.weight += weight;
    else if (this.stacks.size < PROFILING.maxStacksKept) this.stacks.set(id, { keys, weight });
  }

  /** The heaviest stacks that fit the event's limits (frames, stacks, bytes). */
  event(kind: ProfileKind, extra: Partial<ProfileEvent>): Omit<ProfileEvent, "event_id" | "client_ts"> {
    const sorted = [...this.stacks.values()].sort((a, b) => b.weight - a.weight);
    let take = Math.min(sorted.length, LIMITS.maxProfileStacks);
    for (;;) {
      const frames: ProfileFrame[] = [];
      const index = new Map<string, number>();
      const stacks: ProfileEvent["stacks"] = [];
      for (const s of sorted.slice(0, take)) {
        const fresh = s.keys.filter((k) => !index.has(k));
        if (index.size + new Set(fresh).size > LIMITS.maxProfileFrames) continue;
        for (const k of fresh) if (!index.has(k)) index.set(k, frames.push(this.frames.get(k)!) - 1);
        stacks.push({ frames: s.keys.map((k) => index.get(k)!), weight: s.weight });
      }
      const ev = { type: "profile" as const, kind, window_ms: Math.round(this.windowMs), samples: this.samples, frames, stacks, ...extra };
      if (JSON.stringify(ev).length <= LIMITS.maxProfileBytes - 200 || take === 0) return ev;
      take = Math.floor(take * 0.8);
    }
  }
}

/** Root-to-leaf frames of a node, leaf-most `depth` kept, consecutive repeats of a placeholder folded. */
function stackOf(leaf: number, parent: Map<number, number>, frameOfNode: (id: number) => ProfileFrame | typeof IDLE | undefined, depth: number): ProfileFrame[] | typeof IDLE {
  const out: ProfileFrame[] = [];
  for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) {
    const f = frameOfNode(id);
    if (f === IDLE) return IDLE;
    if (!f) continue;
    const prev = out[out.length - 1];
    if (prev && f.file.startsWith("(") && frameKey(prev) === frameKey(f)) continue;
    out.push(f);
  }
  return out.reverse().slice(-depth);
}

export interface ProfilerOptions {
  root: string;
  inspector?: InspectorModule | undefined;
  /** Benchmarks: the main-thread work of each window. */
  onWindow?: ((info: { workMs: number; startMs?: number; samples: number }) => void) | undefined;
  now?: () => number;
  /** Tests: no timers; they call cpuWindow(), send() and heapProfile() themselves. */
  manual?: boolean;
  /** Benchmarks: other window timing (everyMs = windowMs samples all the time, the worst case). */
  timing?: { windowMs?: number; everyMs?: number; ignoreLoad?: boolean; idleRetryMs?: number; idleWaitMs?: number; startBudgetMs?: number } | undefined;
  /** The profiler paused the app this long (starting a window); the adapter keeps it out of its lag metrics. */
  onPause?: ((ms: number) => void) | undefined;
}

export class Profiler {
  private session: InspectorSession | undefined;
  private state: ProfilerState = PROFILER_STATE.off;
  private gapMs: number = PROFILING.everyMs;
  private overruns = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sendTimer: ReturnType<typeof setInterval> | undefined;
  private heapTimer: ReturnType<typeof setTimeout> | undefined;
  private load = { lagMs: 0, cpuPercent: 0 };
  private acc = new Map<string, Acc>();
  private readonly startedAt: number;
  private heapSince = 0;
  private stopped = false;
  /** A window is running (they never overlap). */
  private running = false;
  private windowTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the last window started, and the last block-triggered one was asked for. */
  private lastWindowAt = Number.NEGATIVE_INFINITY;
  private lastExtraAt = Number.NEGATIVE_INFINITY;
  private warned = false;
  private readonly now: () => number;

  constructor(
    private readonly client: AbigaailClient,
    private readonly runtime: RuntimeMonitor,
    private readonly report: (err: unknown) => void,
    private readonly warn: (msg: string) => void,
    private readonly opts: ProfilerOptions,
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.windowMs = opts.timing?.windowMs ?? PROFILING.windowMs;
    this.everyMs = opts.timing?.everyMs ?? PROFILING.everyMs;
    this.gapMs = this.everyMs;
    runtime.onBlock = (ms) => this.afterBlock(ms);
  }

  /**
   * A block of ms just ended: unless a window started recently, or an extra
   * one already ran recently, take a window at the next idle moment (the same
   * idle-only start, budgets and auto-off as any window).
   */
  private afterBlock(ms: number): void {
    if (ms < RUNTIME.blockMinMs || !this.session || this.stopped || this.running || this.state === PROFILER_STATE.disabled) return;
    const now = this.now();
    if (now - this.lastWindowAt < PROFILING.blockWindowAfterMs || now - this.lastExtraAt < PROFILING.blockWindowAfterMs) return;
    this.lastExtraAt = now;
    this.guard(() => this.cpuWindow(this.windowMs).then(() => undefined));
  }

  private readonly windowMs: number;
  private readonly everyMs: number;

  /** profiler_state for the metric. */
  get current(): ProfilerState {
    return this.state;
  }

  /** The app's load, from the adapter's metrics: windows wait while it is high. */
  setLoad(lagMs: number, cpuPercent: number): void {
    this.load = { lagMs, cpuPercent };
  }

  private post<T>(method: string, params?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const s = this.session;
      if (!s) return reject(new Error("no session"));
      try {
        s.post(method, params, (err, result) => (err ? reject(err) : resolve(result as T)));
      } catch (err) {
        reject(err as Error);
      }
    });
  }

  /** Off for good, with one warning; the SDK carries on. */
  private disable(why: string, state: ProfilerState = PROFILER_STATE.disabled): void {
    this.state = state;
    this.clearTimers();
    try {
      this.session?.disconnect();
    } catch {
      // Already gone.
    }
    this.session = undefined;
    if (!this.warned) {
      this.warned = true;
      this.warn(why);
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.windowTimer) clearTimeout(this.windowTimer);
    if (this.heapTimer) clearTimeout(this.heapTimer);
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.timer = this.heapTimer = this.sendTimer = undefined;
  }

  async start(): Promise<void> {
    try {
      const inspector = this.opts.inspector ?? (process.getBuiltinModule?.("node:inspector") as InspectorModule | undefined);
      if (!inspector) return this.disable("profiling needs node:inspector, which this runtime does not have; it is off", PROFILER_STATE.off);
      this.session = new inspector.Session();
      this.session.connect();
      await this.post("Profiler.enable");
      await this.post("Profiler.setSamplingInterval", { interval: PROFILING.samplingIntervalUs });
      await this.post("HeapProfiler.enable");
      await this.post("HeapProfiler.startSampling", { samplingInterval: PROFILING.heapSamplingBytes });
      this.heapSince = this.now();
      if (this.stopped) return this.disable("stopped", PROFILER_STATE.off);
      this.state = PROFILER_STATE.on;
      if (this.opts.manual) return;
      this.schedule(this.everyMs);
      this.sendTimer = setInterval(() => this.guard(() => this.send()), PROFILING.sendEveryMs);
      this.sendTimer.unref();
      this.scheduleHeap();
    } catch (err) {
      this.report(err);
      this.disable("profiling could not start (another profiler or debugger attached?); it is off");
    }
  }

  private guard(fn: () => void | Promise<void>): void {
    Promise.resolve()
      .then(fn)
      .catch((err: unknown) => {
        this.report(err);
        this.disable("profiling failed and is off for this process");
      });
  }

  private schedule(ms: number): void {
    if (this.stopped || this.state === PROFILER_STATE.disabled) return;
    this.timer = setTimeout(
      () =>
        this.guard(async () => {
          await this.cpuWindow(this.windowMs);
          this.schedule(Math.max(0, this.gapMs - this.windowMs));
        }),
      ms,
    );
    this.timer.unref();
  }

  private backOff(): void {
    this.gapMs = Math.min(Math.max(this.gapMs, this.everyMs) * 2, PROFILING.maxGapMs);
    this.state = PROFILER_STATE.backingOff;
  }

  /**
   * One CPU window of `ms`, unless the app is busy or ingest is unreachable
   * (then the gap to the next one doubles). Returns whether it ran.
   */
  async cpuWindow(ms: number = PROFILING.windowMs): Promise<boolean> {
    if (!this.session || this.state === PROFILER_STATE.disabled || this.running) return false;
    this.running = true;
    try {
      return await this.runWindow(ms);
    } finally {
      this.running = false;
    }
  }

  private async runWindow(ms: number): Promise<boolean> {
    const busy = !this.opts.timing?.ignoreLoad && (this.load.lagMs > PROFILING.lagLimitMs || this.load.cpuPercent > PROFILING.cpuLimitPercent);
    if (busy || this.client.stats().breaker !== "closed") {
      this.backOff();
      return false;
    }
    if (!(await this.idle())) return false;
    this.lastWindowAt = this.now();
    this.runtime.startLog();
    const t0 = this.runtime.clock();
    const s0 = this.now();
    await this.post("Profiler.start");
    const startMs = this.now() - s0;
    // Starting the profile paused the app (V8 recorded its code): that is ours, not the app's.
    this.runtime.notePause(t0, this.runtime.clock());
    this.opts.onPause?.(startMs);
    await new Promise<void>((resolve) => {
      this.windowTimer = setTimeout(resolve, ms);
      this.windowTimer.unref();
    });
    if (!this.session) return false;
    const w0 = this.now();
    const { profile } = await this.post<{ profile: CpuProfile }>("Profiler.stop");
    const log = this.runtime.stopLog();
    const samples = this.merge(profile, t0, log, ms);
    const workMs = this.now() - w0;
    this.opts.onWindow?.({ workMs, startMs, samples });
    if (workMs > PROFILING.budgetMs || startMs > (this.opts.timing?.startBudgetMs ?? PROFILING.startBudgetMs)) {
      if (++this.overruns >= PROFILING.maxOverruns) {
        this.disable(
          `profiling went over its budget (${PROFILING.startBudgetMs} ms to start a window, ${PROFILING.budgetMs} ms to read it) ${PROFILING.maxOverruns} times; it is off for this process`,
        );
        return true;
      }
      this.backOff();
    } else {
      this.gapMs = this.everyMs;
      this.state = PROFILER_STATE.on;
    }
    return true;
  }

  /** Waits until no request is in flight; false after idleWaitMs (the window is skipped). */
  private async idle(): Promise<boolean> {
    const retry = this.opts.timing?.idleRetryMs ?? PROFILING.idleRetryMs;
    const until = this.now() + (this.opts.timing?.idleWaitMs ?? PROFILING.idleWaitMs);
    for (;;) {
      if (this.runtime.busyRequests() === 0) return true;
      if (this.now() >= until || !this.session || this.stopped) return false;
      await new Promise<void>((resolve) => {
        this.windowTimer = setTimeout(resolve, retry);
        this.windowTimer.unref();
      });
    }
  }

  private accFor(key: string): Acc {
    let a = this.acc.get(key);
    if (!a) this.acc.set(key, (a = new Acc()));
    return a;
  }

  /**
   * Each sample goes to the whole-app profile; to a route only when exactly
   * one request was in flight at its time; and to the block profile when it
   * fell inside a block the runtime monitor saw.
   */
  merge(profile: CpuProfile, t0: number, log: WindowLog, windowMs: number = PROFILING.windowMs): number {
    const parent = new Map<number, number>();
    const byId = new Map<number, CpuNode>();
    for (const n of profile.nodes) {
      byId.set(n.id, n);
      for (const c of n.children ?? []) parent.set(c, n.id);
    }
    const frameMemo = new Map<number, ProfileFrame | typeof IDLE | undefined>();
    const frameOfNode = (id: number) => {
      if (!frameMemo.has(id)) frameMemo.set(id, byId.has(id) ? profileFrame(byId.get(id)!.callFrame, this.opts.root) : undefined);
      return frameMemo.get(id);
    };
    const stackMemo = new Map<number, ProfileFrame[] | typeof IDLE>();
    const stackOfNode = (id: number) => {
      if (!stackMemo.has(id)) stackMemo.set(id, stackOf(id, parent, frameOfNode, LIMITS.maxProfileDepth));
      return stackMemo.get(id)!;
    };
    const requests = [...log.requests].sort((a, b) => a.start - b.start);
    const app = this.accFor("cpu");
    app.windowMs += windowMs;
    const routeAccs = new Set<Acc>();
    let t = t0;
    let kept = 0;
    let next = 0;
    const active: { end: number; route: string }[] = [];
    const ids = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    for (let i = 0; i < ids.length; i++) {
      t += (deltas[i] ?? 0) / 1000;
      const stack = stackOfNode(ids[i]!);
      if (stack === IDLE || !stack.length) continue;
      kept++;
      app.add(stack, 1);
      while (next < requests.length && requests[next]!.start <= t) active.push(requests[next++]!);
      for (let k = active.length - 1; k >= 0; k--) if (active[k]!.end < t) active.splice(k, 1);
      if (active.length === 1) {
        const r = this.accFor(`route:${active[0]!.route}`);
        r.add(stack, 1);
        routeAccs.add(r);
      } else if (active.length > 1) app.concurrent++;
      else app.idle++;
      if (log.blocks.some((b) => t >= b.end - b.ms && t <= b.end)) this.accFor("block").add(stack, 1);
    }
    for (const r of routeAccs) r.windowMs += windowMs;
    if (this.acc.has("block")) this.acc.get("block")!.windowMs += windowMs;
    return kept;
  }

  private get announced(): boolean {
    return this.client.features()?.has("profile_v1") === true;
  }

  /** Sends what the windows merged, then starts over. */
  send(): void {
    const acc = this.acc;
    this.acc = new Map();
    if (!this.announced) return;
    const app = acc.get("cpu");
    if (app?.samples) this.client.capture(app.event("cpu", { samples_concurrent: app.concurrent, samples_idle: app.idle }));
    const routes = [...acc]
      .filter(([k, a]) => k.startsWith("route:") && a.samples >= PROFILING.minRouteSamples)
      .sort((a, b) => b[1].samples - a[1].samples)
      .slice(0, PROFILING.maxRoutes);
    for (const [k, a] of routes) this.client.capture(a.event("cpu", { route: k.slice("route:".length) }));
    const block = acc.get("block");
    if (block?.samples) this.client.capture(block.event("block", {}));
  }

  private scheduleHeap(): void {
    if (this.stopped || this.state === PROFILER_STATE.disabled) return;
    const young = this.now() - this.startedAt < PROFILING.heapEarlyForMs;
    this.heapTimer = setTimeout(() => this.guard(async () => {
      await this.heapProfile();
      this.scheduleHeap();
    }), young ? PROFILING.heapEarlyEveryMs : PROFILING.heapEveryMs);
    this.heapTimer.unref();
  }

  /** Live sampled heap by the site that allocated it: the top sites, each with its allocation stack. */
  async heapProfile(): Promise<void> {
    if (!this.announced || this.state === PROFILER_STATE.disabled) return;
    const w0 = this.now();
    const { profile } = await this.post<{ profile: { head: HeapNode } }>("HeapProfiler.getSamplingProfile");
    const acc = new Acc();
    acc.windowMs = this.now() - this.heapSince;
    const walk = (node: HeapNode, path: ProfileFrame[]) => {
      const f = profileFrame(node.callFrame, this.opts.root);
      const here = f && f !== IDLE ? [...path, f] : path;
      if (node.selfSize > 0 && here.length) acc.add(here.slice(-PROFILING.heapDepth), node.selfSize);
      for (const c of node.children ?? []) walk(c, here.length > 64 ? here.slice(-64) : here);
    };
    walk(profile.head, []);
    // Only the biggest sites are sent; the total still counts everything.
    const top = [...acc.stacks].sort((a, b) => b[1].weight - a[1].weight).slice(PROFILING.heapSites);
    for (const [id] of top) acc.stacks.delete(id);
    this.client.capture(acc.event("heap", {}));
    this.opts.onWindow?.({ workMs: this.now() - w0, samples: 0 });
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.session?.disconnect();
    } catch {
      // Already gone.
    }
    this.session = undefined;
    if (this.state !== PROFILER_STATE.disabled) this.state = PROFILER_STATE.off;
  }
}
