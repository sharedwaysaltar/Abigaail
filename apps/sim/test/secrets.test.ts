// The sim app's ingest key lives only in memory and in the demo child's
// environment: never in the log, the report, or anything printed.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateIngestKey } from "@abigaail/store";
import { Log, NextDemo, NodeDemo, redact } from "@abigaail/sim";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-simkey-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ingest key", () => {
  const key = generateIngestKey();

  it("is redacted from anything a child prints before it reaches the log", async () => {
    expect(redact(`[demo] using ${key} now`)).toBe("[demo] using abk_[redacted] now");
    const log = new Log(join(dir, "sim.log"));
    log.write("demo-node", `ABIGAAIL_INGEST_KEY=${key}`);
    await log.close();
    const text = readFileSync(join(dir, "sim.log"), "utf8");
    expect(text).toContain("abk_[redacted]");
    expect(text).not.toContain(key);
  });

  it("is not visible on the demo objects, printed or serialised", async () => {
    const log = new Log(join(dir, "sim.log"));
    for (const demo of [new NodeDemo(key, log), new NextDemo(key, log)]) {
      expect(JSON.stringify(demo)).not.toContain("abk_");
      expect(inspect(demo, { depth: 5, showHidden: true })).not.toContain("abk_");
    }
    await log.close();
  });
});
