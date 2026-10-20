// demo-node's fault switches: only the simulator's IPC channel can flip them,
// malformed messages are ignored, and the simulator's model of the demo uses
// the same numbers as the demo itself.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DEPENDENCY_MS as DEMO_DEP, faultControl, NORMAL_FAULTS as DEMO_NORMAL, NORMAL_MS, parseFaults, SLOW_SEARCH_MS as DEMO_SLOW } from "../../demo-node/faults.mjs";
import { DEPENDENCY_MS, NODE_MS, NORMAL_FAULTS, SLOW_SEARCH_MS } from "@abigaail/sim";

const failing = { type: "faults", faults: { dependency: "failing", slowSearch: true, userErrorShare: 0.5 } };

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
    { type: "faults", faults: { dependency: "down", slowSearch: false, userErrorShare: 0 } },
    { type: "faults", faults: { dependency: "ok", slowSearch: "yes", userErrorShare: 0 } },
    { type: "faults", faults: { dependency: "ok", slowSearch: false, userErrorShare: 2 } },
    { type: "faults", faults: { dependency: "ok", slowSearch: false } },
    { type: "faults", faults: { dependency: "ok", slowSearch: false, userErrorShare: 0, exec: "x" } },
    { type: "faults", faults: { dependency: "ok", slowSearch: false, userErrorShare: 0 }, extra: 1 },
  ])("rejects malformed message %j", (msg) => {
    expect(parseFaults(msg)).toBeUndefined();
  });

  it("the simulator's model uses the demo's numbers", () => {
    expect(NODE_MS).toEqual(NORMAL_MS);
    expect(DEPENDENCY_MS).toEqual(DEMO_DEP);
    expect(SLOW_SEARCH_MS).toBe(DEMO_SLOW);
    expect(NORMAL_FAULTS).toEqual(DEMO_NORMAL);
  });
});
