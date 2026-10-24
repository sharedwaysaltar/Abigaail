// Profiles (profile_v1, DECISIONS #118-#121), read for the agents and the
// Runtime tab: stored profiles merged by frame identity, top functions, a
// flame tree, the heap sites whose retained memory grows, and the functions
// behind event-loop blocks. Frames are function names, project-relative files
// and lines, or placeholders; nothing else was ever sent.

import type { ProfileRow, StoreReader } from "@abigaail/store";

export interface Frame {
  file: string;
  line: number;
  fn?: string;
}

export interface Merged {
  frames: Map<string, Frame>;
  /** Root-to-leaf frame keys and their weight. */
  stacks: Map<string, { keys: string[]; weight: number }>;
  /** All samples (or bytes), including those in no kept stack. */
  samples: number;
  concurrent: number;
  idle: number;
  windowMs: number;
  profiles: number;
}

export const PROFILE_VIEW = {
  /** Profiles merged for one view at most. */
  maxRows: 300,
  topFunctions: 15,
  /** Flame nodes below this share of the total are not drawn. */
  flameMinShare: 0.005,
  flameMaxNodes: 400,
  /** A heap site counts as growing from this much (bytes) since the start. */
  growthMinBytes: 2 * 1048576,
  /** The function named behind blocks must hold this share of the blocked samples. */
  blockFnMinShare: 0.3,
} as const;

const keyOf = (f: Frame) => `${f.file}:${f.line}:${f.fn ?? ""}`;

/** "renderDocs (src/docs.ts:88)", "(gc)", "(anonymous) (src/x.ts:4)". */
export function frameLabel(f: Frame): string {
  if (f.file.startsWith("(")) return f.fn ? `${f.fn} ${f.file}` : f.file;
  return `${f.fn ?? "(anonymous)"} (${f.file}:${f.line})`;
}

export function merge(rows: readonly ProfileRow[]): Merged {
  const m: Merged = { frames: new Map(), stacks: new Map(), samples: 0, concurrent: 0, idle: 0, windowMs: 0, profiles: rows.length };
  for (const r of rows) {
    m.samples += r.samples;
    m.concurrent += r.samples_concurrent ?? 0;
    m.idle += r.samples_idle ?? 0;
    m.windowMs += r.window_ms;
    const keys = r.frames.map((f) => {
      const k = keyOf(f);
      if (!m.frames.has(k)) m.frames.set(k, { file: f.file, line: f.line, ...(f.fn ? { fn: f.fn } : {}) });
      return k;
    });
    for (const s of r.stacks) {
      const sk = s.frames.map((i) => keys[i]!);
      const id = sk.join("|");
      const cur = m.stacks.get(id);
      if (cur) cur.weight += s.weight;
      else m.stacks.set(id, { keys: sk, weight: s.weight });
    }
  }
  return m;
}

export interface TopFunction {
  frame: Frame;
  label: string;
  /** Samples (or bytes) where it was the leaf, and where it was anywhere on the stack. */
  self: number;
  total: number;
  selfShare: number;
  totalShare: number;
}

/** Functions by self time (or self bytes), with their share of all samples. */
export function topFunctions(m: Merged, n: number = PROFILE_VIEW.topFunctions): TopFunction[] {
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  for (const s of m.stacks.values()) {
    const leaf = s.keys.at(-1)!;
    self.set(leaf, (self.get(leaf) ?? 0) + s.weight);
    for (const k of new Set(s.keys)) total.set(k, (total.get(k) ?? 0) + s.weight);
  }
  const all = Math.max(1, m.samples);
  return [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, w]) => {
      const frame = m.frames.get(k)!;
      return { frame, label: frameLabel(frame), self: w, total: total.get(k) ?? w, selfShare: w / all, totalShare: (total.get(k) ?? w) / all };
    });
}

export interface FlameNode {
  label: string;
  frame: Frame | null;
  value: number;
  children: FlameNode[];
}

/** The merged stacks as a tree from the root; small nodes dropped, the node count bounded. */
export function flameTree(m: Merged): FlameNode {
  const root: FlameNode = { label: "all", frame: null, value: 0, children: [] };
  for (const s of m.stacks.values()) {
    root.value += s.weight;
    let node = root;
    for (const k of s.keys) {
      let child = node.children.find((c) => c.frame !== null && keyOf(c.frame) === k);
      if (!child) node.children.push((child = { label: frameLabel(m.frames.get(k)!), frame: m.frames.get(k)!, value: 0, children: [] }));
      child.value += s.weight;
      node = child;
    }
  }
  const min = root.value * PROFILE_VIEW.flameMinShare;
  let budget: number = PROFILE_VIEW.flameMaxNodes;
  const prune = (n: FlameNode) => {
    n.children = n.children.filter((c) => c.value >= min).sort((a, b) => b.value - a.value);
    for (const c of n.children) {
      if (--budget <= 0) {
        c.children = [];
        continue;
      }
      prune(c);
    }
  };
  prune(root);
  return root;
}

export interface HeapSite {
  frame: Frame;
  label: string;
  /** Sampled live bytes at the site in the first and the latest heap profile since the start. */
  firstBytes: number;
  lastBytes: number;
  growthBytes: number;
}

/** Live sampled bytes per allocating function (the leaf of each heap stack). */
function bytesBySite(row: ProfileRow): Map<string, { frame: Frame; bytes: number }> {
  const out = new Map<string, { frame: Frame; bytes: number }>();
  for (const s of row.stacks) {
    const f = row.frames[s.frames.at(-1)!]!;
    const k = keyOf(f);
    const cur = out.get(k);
    if (cur) cur.bytes += s.weight;
    else out.set(k, { frame: f, bytes: s.weight });
  }
  return out;
}

/**
 * Heap sites whose sampled live bytes grew between the first and the latest
 * heap profile in [from, to) (from = the process's start): where a leak is
 * allocated. Biggest growth first.
 */
export function growingSites(store: StoreReader, appId: string, from: number, to: number): HeapSite[] {
  const rows = store.profiles(appId, "heap", from, to, PROFILE_VIEW.maxRows);
  if (!rows.length) return [];
  const last = bytesBySite(rows[0]!);
  const first = rows.length > 1 ? bytesBySite(rows.at(-1)!) : new Map<string, { frame: Frame; bytes: number }>();
  return [...last]
    .map(([k, v]) => ({ frame: v.frame, label: frameLabel(v.frame), firstBytes: first.get(k)?.bytes ?? 0, lastBytes: v.bytes, growthBytes: v.bytes - (first.get(k)?.bytes ?? 0) }))
    .filter((s) => s.growthBytes >= PROFILE_VIEW.growthMinBytes)
    .sort((a, b) => b.growthBytes - a.growthBytes);
}

/** The site holding most sampled heap in the latest heap profile in [from, to). */
export function topHeapSite(store: StoreReader, appId: string, from: number, to: number): { frame: Frame; label: string; share: number } | undefined {
  const row = store.profiles(appId, "heap", from, to, 1)[0];
  if (!row || !row.samples) return undefined;
  const top = [...bytesBySite(row).values()].sort((a, b) => b.bytes - a.bytes)[0];
  return top && !top.frame.file.startsWith("(") ? { frame: top.frame, label: frameLabel(top.frame), share: top.bytes / row.samples } : undefined;
}

/** The functions that ran while the event loop was blocked in [from, to), by self samples. */
export function blockFunctions(store: StoreReader, appId: string, from: number, to: number): TopFunction[] {
  const rows = store.profiles(appId, "block", from, to, PROFILE_VIEW.maxRows);
  return rows.length ? topFunctions(merge(rows), 5) : [];
}

export interface ProfileView {
  windowMs: number;
  route: string | null;
  /** Routes with a profile in the window, busiest first. */
  routes: { route: string; samples: number }[];
  /** null without any cpu profile in the window. */
  cpu: { samples: number; concurrent: number; idle: number; profiles: number; top: TopFunction[]; flame: FlameNode } | null;
  block: TopFunction[];
  /** Heap sites growing since the latest start, and the latest heap profile's top sites. */
  heapGrowing: HeapSite[];
  heapTop: TopFunction[];
}

/** The Runtime tab's profiles: CPU for the whole app or one route, blocks and heap. */
export function profileView(store: StoreReader, appId: string, now: number, opts: { windowMs: number; route: string | null }): ProfileView {
  const from = now - opts.windowMs;
  const routes = new Map<string, number>();
  for (const r of store.profiles(appId, "cpu", from, now + 1, PROFILE_VIEW.maxRows)) {
    if (r.route !== null) routes.set(r.route, (routes.get(r.route) ?? 0) + r.samples);
  }
  const rows = store.profiles(appId, "cpu", from, now + 1, PROFILE_VIEW.maxRows, opts.route);
  const m = rows.length ? merge(rows) : undefined;
  const boot = store.lastBoot(appId)?.ts ?? from;
  const heap = store.profiles(appId, "heap", boot, now + 1, 1);
  return {
    windowMs: opts.windowMs,
    route: opts.route,
    routes: [...routes].map(([route, samples]) => ({ route, samples })).sort((a, b) => b.samples - a.samples),
    cpu: m ? { samples: m.samples, concurrent: m.concurrent, idle: m.idle, profiles: m.profiles, top: topFunctions(m), flame: flameTree(m) } : null,
    block: blockFunctions(store, appId, from, now + 1),
    heapGrowing: growingSites(store, appId, boot, now + 1).slice(0, 10),
    heapTop: heap.length ? topFunctions(merge(heap), 10) : [],
  };
}
