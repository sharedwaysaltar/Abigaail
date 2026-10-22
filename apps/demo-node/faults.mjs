// Fault switches and normal response times for the bad-traffic simulator
// (`npm run sim`). The switches change only through the IPC channel of a
// process the simulator forked with ABIGAAIL_DEMO_SIM=1; there is no HTTP
// control surface. apps/sim/src/model.ts mirrors these numbers (a test keeps
// them equal), so seeded history matches what this app really does.

/** Normal handler time per route, [min, max] ms, uniform. */
export const NORMAL_MS = {
  "/": [5, 15],
  "/docs": [10, 30],
  "/user/[id]": [8, 20],
  "/search": [40, 80],
  "/checkout": [10, 20],
};
/** The local dependency behind /checkout answers in [min, max] ms when healthy. */
export const DEPENDENCY_MS = [15, 25];
/** /search with slowSearch on. */
export const SLOW_SEARCH_MS = 1200;
/** /docs with blockDocs on: synchronous work that blocks the event loop this long. */
export const BLOCK_DOCS_MS = 300;
/** Largest leak per /search request, KB. */
export const MAX_LEAK_KB = 8192;

/**
 * leakPerRequest: KB each /search request keeps for good (a leak).
 * oomKillMb: with a leak, the process kills itself (SIGKILL) once its heap
 * passes this, as a container's OOM killer would; 0 = off. A real V8
 * out-of-memory abort is not used: it can write a core dump on the machine.
 */
export const NORMAL_FAULTS = Object.freeze({ dependency: "ok", slowSearch: false, userErrorShare: 0, leakPerRequest: 0, blockDocs: false, oomKillMb: 0 });

const KEYS = ["dependency", "slowSearch", "userErrorShare", "leakPerRequest", "blockDocs", "oomKillMb"];
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ type: "faults", faults: { dependency, slowSearch, userErrorShare, leakPerRequest, blockDocs, oomKillMb } }`, or undefined if malformed. */
export function parseFaults(msg) {
  if (!isObject(msg) || msg.type !== "faults" || Object.keys(msg).length !== 2 || !isObject(msg.faults)) return undefined;
  const f = msg.faults;
  if (Object.keys(f).length !== KEYS.length || !KEYS.every((k) => k in f)) return undefined;
  if (f.dependency !== "ok" && f.dependency !== "failing") return undefined;
  if (typeof f.slowSearch !== "boolean") return undefined;
  if (typeof f.userErrorShare !== "number" || !(f.userErrorShare >= 0 && f.userErrorShare <= 1)) return undefined;
  if (!isInt(f.leakPerRequest, 0, MAX_LEAK_KB) || typeof f.blockDocs !== "boolean" || !isInt(f.oomKillMb, 0, 65536)) return undefined;
  return Object.freeze({
    dependency: f.dependency,
    slowSearch: f.slowSearch,
    userErrorShare: f.userErrorShare,
    leakPerRequest: f.leakPerRequest,
    blockDocs: f.blockDocs,
    oomKillMb: f.oomKillMb,
  });
}

/**
 * Current faults. Listens for fault messages only when this process has an
 * IPC channel (it was forked) and ABIGAAIL_DEMO_SIM=1; otherwise the app
 * always behaves normally. Malformed messages are ignored.
 */
export function faultControl(proc = process) {
  let faults = NORMAL_FAULTS;
  const enabled = typeof proc.send === "function" && proc.env.ABIGAAIL_DEMO_SIM === "1";
  if (enabled) {
    proc.on("message", (msg) => {
      const next = parseFaults(msg);
      if (!next) return;
      faults = next;
      proc.send({ type: "faults-applied" });
    });
  }
  return { enabled, get: () => faults };
}
