// demo-node's fault switches: only the simulator's IPC channel can flip them,
// malformed messages are ignored, and the simulator's model of the demo uses
// the same numbers as the demo itself.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  BLOCK_DOCS_MS as DEMO_BLOCK,
  DEPENDENCY_MS as DEMO_DEP,
  faultControl,
  NORMAL_FAULTS as DEMO_NORMAL,
  NORMAL_MS,
  parseFaults,
  SLOW_SEARCH_MS as DEMO_SLOW,
} from "../../demo-node/faults.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCK_DOCS_MS, DEMO_FRAMES, DEPENDENCY_MS, NODE_MS, NORMAL_FAULTS, REPO_ROOT, SLOW_SEARCH_MS } from "@abigaail/sim";

const ok = { dependency: "ok", slowSearch: false, userErrorShare: 0, leakPerRequest: 0, leakPerSecond: 0, blockDocs: false, oomKillMb: 0, checkoutBug: 0, searchExtraMs: 0, crashAfterMs: 0 };
const failing = { type: "faults", faults: { dependency: "failing", slowSearch: true, userErrorShare: 0.5, leakPerRequest: 2560, leakPerSecond: 448, blockDocs: true, oomKillMb: 96, checkoutBug: 0.4, searchExtraMs: 110, crashAfterMs: 30_000 } };

function proc(opts: { ipc: boolean; env?: Record<string, string> }) {
  const e = new EventEmitter();
  const sent: unknown[] = [];
  return Object.assign(e, { env: opts.env ?? {}, sent, ...(opts.ipc ? { send: (m: unknown) => sent.push(m) } : {}) });
}

describe("fault control", () => {
  it("applies a valid message when forked by the simulator, and acknowledges it", () => {
    const p = proc({ ipc: true, env: { ABIGAAIL_DEMO_SIM: "1" } });
    const c = faultControl(p);
    expect(c.enabled).toBe(true);
    p.emit("message", failing);
    expect(c.get()).toEqual(failing.faults);
    expect(p.sent).toEqual([{ type: "faults-applied" }]);
  });

  it("ignores messages without ABIGAAIL_DEMO_SIM=1, and without an IPC channel", () => {
    for (const p of [proc({ ipc: true }), proc({ ipc: false, env: { ABIGAAIL_DEMO_SIM: "1" } })]) {
      const c = faultControl(p);
      expect(c.enabled).toBe(false);
      p.emit("message", failing);
      expect(c.get()).toEqual(DEMO_NORMAL);
    }
  });

  it.each([
    null,
    "faults",
    { type: "faults" },
    { type: "faults", faults: { ...ok, dependency: "down" } },
    { type: "faults", faults: { ...ok, slowSearch: "yes" } },
    { type: "faults", faults: { ...ok, userErrorShare: 2 } },
    { type: "faults", faults: { ...ok, leakPerRequest: -1 } },
    { type: "faults", faults: { ...ok, leakPerRequest: 1e9 } },
    { type: "faults", faults: { ...ok, leakPerRequest: 1.5 } },
    { type: "faults", faults: { ...ok, leakPerSecond: -5 } },
    { type: "faults", faults: { ...ok, leakPerSecond: 1e9 } },
    { type: "faults", faults: { ...ok, blockDocs: 1 } },
    { type: "faults", faults: { ...ok, oomKillMb: "96" } },
    { type: "faults", faults: { ...ok, checkoutBug: 1.5 } },
    { type: "faults", faults: { ...ok, checkoutBug: "0.4" } },
    { type: "faults", faults: { ...ok, searchExtraMs: -1 } },
    { type: "faults", faults: { ...ok, searchExtraMs: 60_000 } },
    { type: "faults", faults: { ...ok, crashAfterMs: 0.5 } },
    { type: "faults", faults: { ...ok, crashAfterMs: 1e9 } },
    { type: "faults", faults: { dependency: "ok", slowSearch: false, userErrorShare: 0 } },
    { type: "faults", faults: { ...ok, exec: "x" } },
    { type: "faults", faults: ok, extra: 1 },
  ])("rejects malformed message %j", (msg) => {
    expect(parseFaults(msg)).toBeUndefined();
  });

  it("the simulator's model uses the demo's numbers", () => {
    expect(NODE_MS).toEqual(NORMAL_MS);
    expect(DEPENDENCY_MS).toEqual(DEMO_DEP);
    expect(SLOW_SEARCH_MS).toBe(DEMO_SLOW);
    expect(BLOCK_DOCS_MS).toBe(DEMO_BLOCK);
    // The replay's profiles name the lines the real demo's profiles do.
    const lines = readFileSync(join(REPO_ROOT, DEMO_FRAMES.renderDocs.file), "utf8").split("\n");
    for (const f of [DEMO_FRAMES.renderDocs, DEMO_FRAMES.rememberSearch]) expect(lines[f.line - 1]).toContain(`export function ${f.fn}(`);
    // The release faults' frames are the lines that throw.
    expect(lines[DEMO_FRAMES.applyDiscount.line - 2]).toContain("export function applyDiscount(");
    expect(lines[DEMO_FRAMES.applyDiscount.line - 1]).toContain("cart.totals.amount");
    expect(lines[DEMO_FRAMES.runMigrations.line - 2]).toContain("export function runMigrations(");
    expect(lines[DEMO_FRAMES.runMigrations.line - 1]).toContain("throw new MigrationError(");
    expect(NORMAL_FAULTS).toEqual(DEMO_NORMAL);
  });
});
