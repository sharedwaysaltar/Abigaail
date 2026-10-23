// The demo's faults, run for real (owner's chunk 10a test): the replay models
// the heap and the event loop instead of running the demo, so it cannot see a
// fault that does nothing. This runs the demo's own code in a child process and
// measures what it does: the leak keeps real heap, and renderDocs blocks the loop.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCK_DOCS_MS, REPO_ROOT } from "@abigaail/sim";

const FAULTS = pathToFileURL(join(REPO_ROOT, "apps/demo-node/faults.mjs")).href;

function child(script: string): Record<string, number> {
  const out = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "" } });
  return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, number>;
}

describe("demo-node's faults do what the scenarios say", () => {
  it("the leak keeps the heap it is asked to: 40 MB in 2.5 MB requests, as oom-loop sends them", () => {
    const { grewMb } = child(`
      import v8 from "node:v8";
      import { rememberSearch } from ${JSON.stringify(FAULTS)};
      const kept = [];
      gc(); gc();
      const before = v8.getHeapStatistics().used_heap_size;
      for (let i = 0; i < 16; i++) rememberSearch(kept, 2560);
      gc(); gc();
      const after = v8.getHeapStatistics().used_heap_size;
      console.log(JSON.stringify({ grewMb: (after - before) / 1048576, kept: kept.length }));
    `);
    expect(grewMb).toBeGreaterThan(36);
    expect(grewMb).toBeLessThan(48);
  });

  it("the leak in the leak scenario's 64 KB steps keeps it too", () => {
    const { grewMb } = child(`
      import v8 from "node:v8";
      import { rememberSearch } from ${JSON.stringify(FAULTS)};
      const kept = [];
      gc(); gc();
      const before = v8.getHeapStatistics().used_heap_size;
      for (let i = 0; i < 320; i++) rememberSearch(kept, 64);
      gc(); gc();
      console.log(JSON.stringify({ grewMb: (v8.getHeapStatistics().used_heap_size - before) / 1048576 }));
    `);
    expect(grewMb).toBeGreaterThan(18);
    expect(grewMb).toBeLessThan(24);
  });

  it("renderDocs blocks the event loop for BLOCK_DOCS_MS, as measured by the event-loop delay histogram", () => {
    const { maxMs, lateMs } = child(`
      import { monitorEventLoopDelay } from "node:perf_hooks";
      import { renderDocs } from ${JSON.stringify(FAULTS)};
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      await new Promise((r) => setTimeout(r, 50));
      const due = performance.now() + 20;
      const late = new Promise((r) => setTimeout(() => r(performance.now() - due), 20));
      renderDocs(${BLOCK_DOCS_MS});
      const lateMs = await late;
      await new Promise((r) => setTimeout(r, 50));
      h.disable();
      console.log(JSON.stringify({ maxMs: h.max / 1e6, lateMs }));
    `);
    expect(maxMs).toBeGreaterThan(BLOCK_DOCS_MS - 20);
    expect(lateMs).toBeGreaterThan(BLOCK_DOCS_MS - 40);
  });
});
