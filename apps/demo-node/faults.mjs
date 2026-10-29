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
/** Largest extra /search time (searchExtraMs) and longest wait before a crash (crashAfterMs). */
export const MAX_EXTRA_MS = 5000;
export const MAX_CRASH_AFTER_MS = 600_000;

/**
 * leakPerRequest: KB each /search request keeps for good (a leak that follows traffic).
 * leakPerSecond: KB kept for good every second while it is on (a leak that does not).
 * oomKillMb: with a leak, the process kills itself (SIGKILL) once its heap
 * passes this, as a container's OOM killer would; 0 = off. A real V8
 * out-of-memory abort is not used: it can write a core dump on the machine.
 * The release faults (a bad deploy, DECISIONS #134): checkoutBug, the share of
 * /checkout requests that throw a TypeError in applyDiscount (500);
 * searchExtraMs, extra time on every /search; crashAfterMs, an uncaught
 * MigrationError this long after the fault is applied (the simulator applies
 * faults at every start, so a supervised demo crashes in a loop); 0 = off.
 */
export const NORMAL_FAULTS = Object.freeze({ dependency: "ok", slowSearch: false, userErrorShare: 0, leakPerRequest: 0, leakPerSecond: 0, blockDocs: false, oomKillMb: 0, checkoutBug: 0, searchExtraMs: 0, crashAfterMs: 0 });

const KEYS = ["dependency", "slowSearch", "userErrorShare", "leakPerRequest", "leakPerSecond", "blockDocs", "oomKillMb", "checkoutBug", "searchExtraMs", "crashAfterMs"];
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ type: "faults", faults: { dependency, slowSearch, userErrorShare, leakPerRequest, leakPerSecond, blockDocs, oomKillMb, checkoutBug, searchExtraMs, crashAfterMs } }`, or undefined if malformed. */
export function parseFaults(msg) {
  if (!isObject(msg) || msg.type !== "faults" || Object.keys(msg).length !== 2 || !isObject(msg.faults)) return undefined;
  const f = msg.faults;
  if (Object.keys(f).length !== KEYS.length || !KEYS.every((k) => k in f)) return undefined;
  if (f.dependency !== "ok" && f.dependency !== "failing") return undefined;
  if (typeof f.slowSearch !== "boolean") return undefined;
  if (typeof f.userErrorShare !== "number" || !(f.userErrorShare >= 0 && f.userErrorShare <= 1)) return undefined;
  if (!isInt(f.leakPerRequest, 0, MAX_LEAK_KB) || !isInt(f.leakPerSecond, 0, MAX_LEAK_KB) || typeof f.blockDocs !== "boolean" || !isInt(f.oomKillMb, 0, 65536)) return undefined;
  if (typeof f.checkoutBug !== "number" || !(f.checkoutBug >= 0 && f.checkoutBug <= 1)) return undefined;
  if (!isInt(f.searchExtraMs, 0, MAX_EXTRA_MS) || !isInt(f.crashAfterMs, 0, MAX_CRASH_AFTER_MS)) return undefined;
  return Object.freeze({
    dependency: f.dependency,
    slowSearch: f.slowSearch,
    userErrorShare: f.userErrorShare,
    leakPerRequest: f.leakPerRequest,
    leakPerSecond: f.leakPerSecond,
    blockDocs: f.blockDocs,
    oomKillMb: f.oomKillMb,
    checkoutBug: f.checkoutBug,
    searchExtraMs: f.searchExtraMs,
    crashAfterMs: f.crashAfterMs,
  });
}

/**
 * Current faults. Listens for fault messages only when this process has an
 * IPC channel (it was forked) and ABIGAAIL_DEMO_SIM=1; otherwise the app
 * always behaves normally. Malformed messages are ignored.
 */
export function faultControl(proc = process, onChange = () => {}) {
  let faults = NORMAL_FAULTS;
  const enabled = typeof proc.send === "function" && proc.env.ABIGAAIL_DEMO_SIM === "1";
  if (enabled) {
    proc.on("message", (msg) => {
      const next = parseFaults(msg);
      if (!next) return;
      faults = next;
      onChange(faults);
      proc.send({ type: "faults-applied" });
    });
  }
  return { enabled, get: () => faults };
}

/**
 * Keeps `kb` KB of real heap for good in `kept`: one 8192-element array of
 * small integers (8 bytes each, 64 KB) per 64 KB. Not a string: V8 builds
 * "x".repeat(n) as a rope, which retained about 0.6 MB for 40 MB intended
 * (owner's measurement); a live test checks the heap really grows.
 */
export function rememberSearch(kept, kb) {
  for (let i = 0; i < kb / 64; i++) kept.push(new Array(8192).fill(kept.length));
}

const DOC_SECTIONS = Array.from({ length: 40 }, (_, i) => ({
  title: `Section ${i + 1}`,
  paragraphs: Array.from({ length: 6 }, (_, k) => `Paragraph ${k + 1} of section ${i + 1}: how the API behaves, with <examples> & "notes".`),
  code: `const x${i} = await client.get("/items/${i}");`,
}));

/**
 * Synchronous work that blocks the event loop for `ms`: renders the docs page
 * to HTML again and again, as a server-side renderer would (a live test
 * measures the lag). Real rendering, not a three-line spin: V8 inlines small
 * functions into their caller, and a CPU profile then names the caller instead
 * (DECISIONS #123); a function this size is not inlined.
 */
export function renderDocs(ms) {
  const until = performance.now() + ms;
  let html = "";
  let pages = 0;
  while (performance.now() < until) {
    const parts = ["<!doctype html><html><head><title>Docs</title></head><body><nav><ul>"];
    for (const s of DOC_SECTIONS) parts.push(`<li><a href="#${s.title.toLowerCase().replace(/\s+/g, "-")}">${s.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</a></li>`);
    parts.push("</ul></nav><main>");
    for (const s of DOC_SECTIONS) {
      parts.push(`<section id="${s.title.toLowerCase().replace(/\s+/g, "-")}"><h2>${s.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</h2>`);
      for (const p of s.paragraphs) parts.push(`<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</p>`);
      parts.push(`<pre><code>${s.code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</code></pre></section>`);
    }
    parts.push(`</main><footer>${pages} renders</footer></body></html>`);
    html = parts.join("");
    pages++;
  }
  return html.length + pages;
}

/** A bad release's bug: a cart without totals (checkoutBug). Throws a TypeError, as such code would. */
export function applyDiscount(cart) {
  return cart.totals.amount * 0.9;
}

/** A failed migration at startup (crashAfterMs): an uncaught error ends the process. */
export class MigrationError extends Error {
  name = "MigrationError";
}
export function runMigrations() {
  throw new MigrationError("migration failed: column already exists");
}
