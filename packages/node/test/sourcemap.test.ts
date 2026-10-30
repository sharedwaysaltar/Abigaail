// Opt-in source maps (DECISIONS #136): compiled frames mapped to source lines
// with node:module's SourceMap, under the same path rules as every frame
// (project-relative or not mapped), within budgets, never keeping the code,
// with one hint when frames are compiled and no map is found.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, profileFrame, SourceMapper, sourceMapsWanted, type AbigaailNode } from "@abigaail/node";
import type { Transport } from "@abigaail/core";
import type { Batch, ErrorEvent } from "@abigaail/schema";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += B64[digit];
  } while (v);
  return out;
}
/** Generated line i, column 0 → source 0, original line i + offset, column 0. */
function mappings(lines: number, offset: number): string {
  return Array.from({ length: lines }, (_, i) => [0, 0, i === 0 ? offset : 1, 0].map(vlq).join("")).join(";");
}

let root: string;
let warnings: string[];
let adapter: AbigaailNode | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "abigaail-maps-"));
  warnings = [];
});
afterEach(async () => {
  await adapter?.shutdown(100);
  adapter = undefined;
  rmSync(root, { recursive: true, force: true });
});

const SECRET_CODE = "const apiKey = 'SOURCE_CODE_MARKER';";

/** dist/<name>.js with `lines` lines and a map to `source` (offset 10), next to it. */
function compiled(name: string, source: string, o: { comment?: string; mapName?: string; extra?: Record<string, unknown>; noMap?: boolean } = {}): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  const mapName = o.mapName ?? `${name}.js.map`;
  writeFileSync(join(root, "dist", `${name}.js`), `${Array.from({ length: 20 }, (_, i) => `line${i}();`).join("\n")}\n${o.comment ?? `//# sourceMappingURL=${mapName}`}\n`);
  if (o.noMap) return;
  writeFileSync(join(root, "dist", mapName), JSON.stringify({ version: 3, file: `${name}.js`, sources: [source], sourcesContent: [SECRET_CODE], names: [], mappings: mappings(20, 10), ...o.extra }));
}

const mapper = (opts: ConstructorParameters<typeof SourceMapper>[2] = {}) => new SourceMapper(root, (m) => warnings.push(m), opts);
const frame = (file: string, line = 3) => ({ file, line, col: 1 });

describe("mapping", () => {
  it("maps a compiled frame to the source file and line, with the map named by sourceMappingURL", async () => {
    compiled("app", "../src/app.ts");
    const m = mapper();
    expect(m.missing(["dist/app.js", "src/x.ts", "node_modules/lib/index.js"])).toEqual(["dist/app.js"]);
    await m.load(["dist/app.js"]);
    expect(m.mapFrames([frame("dist/app.js", 3), frame("src/x.ts", 7)])).toEqual([{ file: "src/app.ts", line: 13, col: 1 }, frame("src/x.ts", 7)]);
    // A line past the map's end is not guessed.
    expect(m.mapFrames([frame("dist/app.js", 30)])).toEqual([frame("dist/app.js", 30)]);
    expect(warnings).toEqual([]);
  });

  it("finds <file>.map without a comment, and honours sourceRoot", async () => {
    compiled("a", "a.ts", { comment: "", extra: { sourceRoot: "../src/" } });
    const m = mapper();
    await m.load(["dist/a.js"]);
    expect(m.mapFrames([frame("dist/a.js", 1)])[0]).toMatchObject({ file: "src/a.ts", line: 11 });
  });

  it("bundler sources (webpack://, turbopack://) are project-relative", async () => {
    compiled("w", "webpack://my-app/./src/app/page.tsx");
    compiled("t", "turbopack:///[project]/src/lib/db.ts");
    const m = mapper();
    await m.load(["dist/w.js", "dist/t.js"]);
    expect(m.mapFrames([frame("dist/w.js"), frame("dist/t.js")]).map((f) => f.file)).toEqual(["src/app/page.tsx", "src/lib/db.ts"]);
  });

  it("the same path rules: a source outside the project, absolute, a URL or with '..' leaves the compiled frame as it was", async () => {
    const outside = ["../../../../home/someone/secret.ts", "/home/someone/project/src/a.ts", "file:///home/someone/a.ts", "https://example.com/a.ts", "webpack://app/../../etc/a.ts", "webpack://app/src/a b.ts"];
    outside.forEach((src, i) => compiled(`o${i}`, src));
    const m = mapper();
    const files = outside.map((_, i) => `dist/o${i}.js`);
    await m.load(files);
    expect(m.mapFrames(files.map((f) => frame(f)))).toEqual(files.map((f) => frame(f)));
  });

  it("never keeps the source code: sourcesContent is dropped before the map is built", async () => {
    compiled("app", "../src/app.ts");
    const m = mapper();
    await m.load(["dist/app.js"]);
    const cache = (m as unknown as { cache: Map<string, { map: { payload: Record<string, unknown> } }> }).cache;
    const payload = cache.get("dist/app.js")!.map.payload;
    expect(payload.sourcesContent).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("SOURCE_CODE_MARKER");
  });

  it("a map outside the project, an inline (data:) map, or a dependency's file is not read", async () => {
    compiled("far", "../src/far.ts", { comment: "//# sourceMappingURL=../../outside.js.map" });
    writeFileSync(join(root, "..", "outside.js.map"), JSON.stringify({ version: 3, sources: ["../src/far.ts"], mappings: mappings(5, 0) }));
    compiled("inline", "../src/i.ts", { comment: "//# sourceMappingURL=data:application/json;base64,e30=" });
    const m = mapper();
    await m.load(["dist/far.js", "dist/inline.js", "node_modules/x/dist/index.js"]);
    expect(m.mapFrames([frame("dist/far.js"), frame("dist/inline.js")]).map((f) => f.file)).toEqual(["dist/far.js", "dist/inline.js"]);
    expect(m.missing(["node_modules/x/dist/index.js", "../up.js"])).toEqual([]);
    rmSync(join(root, "..", "outside.js.map"), { force: true });
  });
});

describe("budgets", () => {
  it("a map larger than maxMapBytes is not read", async () => {
    compiled("big", "../src/big.ts");
    const m = mapper({ limits: { maxMapBytes: 100 } });
    await m.load(["dist/big.js"]);
    expect(m.mapFrames([frame("dist/big.js")])[0]!.file).toBe("dist/big.js");
  });

  it("at most maxMaps stay in memory", async () => {
    for (let i = 0; i < 5; i++) compiled(`m${i}`, `../src/m${i}.ts`);
    const m = mapper({ limits: { maxMaps: 3 } });
    await m.load([0, 1, 2, 3, 4].map((i) => `dist/m${i}.js`));
    expect((m as unknown as { cache: Map<string, unknown> }).cache.size).toBe(3);
  });

  it("parsing over budget 3 times turns mapping off for the process, with one warning", async () => {
    for (let i = 0; i < 4; i++) compiled(`s${i}`, `../src/s${i}.ts`);
    let t = 0;
    const m = mapper({ now: () => (t += 150) });
    for (let i = 0; i < 4; i++) await m.load([`dist/s${i}.js`]);
    expect(warnings).toEqual(["source maps took over 100 ms to read 3 times; mapping is off for this process"]);
    expect(m.missing(["dist/s3.js"])).toEqual([]);
    expect(m.mapFrames([frame("dist/s0.js")])[0]!.file).toBe("dist/s0.js");
  });

  it("an error waits at most waitMs for its maps", async () => {
    compiled("app", "../src/app.ts");
    const m = mapper({ limits: { waitMs: 1 } });
    // Hold the queue: the load resolves after waitMs whatever the disk does.
    const t0 = Date.now();
    await m.load(["dist/app.js"]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("in the SDK", () => {
  function start(opts: Parameters<typeof init>[0] = {}) {
    const batches: Batch[] = [];
    const transport: Transport = async (b) => {
      batches.push(structuredClone(b));
      return "ok";
    };
    adapter = init({
      endpoint: "http://127.0.0.1:9/ingest", ingestKey: "k", release: "r1", environment: "test", flushIntervalMs: 0, metricsIntervalMs: 0, heartbeatIntervalMs: 0,
      runtimeSignals: false, transport, env: {}, root, nodeVersion: "24.0.0",
      onInternalError: (e) => warnings.push(e instanceof Error ? e.message : String(e)),
      ...opts,
    });
    const errors = async () => {
      await adapter!.flush();
      return batches.flatMap((b) => b.events).filter((e): e is ErrorEvent => e.type === "error");
    };
    return { errors };
  }
  const thrown = (file: string, line = 3) => {
    const err = new TypeError("boom");
    err.stack = `TypeError: boom\n    at applyDiscount (${join(root, file)}:${line}:1)\n    at ${join(root, "node_modules/lib/index.js")}:1:1`;
    return err;
  };
  const until = async <T>(f: () => Promise<T[]>, n = 1): Promise<T[]> => {
    for (let i = 0; i < 100; i++) {
      const xs = await f();
      if (xs.length >= n) return xs;
      await new Promise((r) => setTimeout(r, 10));
    }
    return f();
  };

  it("sourceMaps: true sends the mapped frame, with the error's own time", async () => {
    compiled("app", "../src/checkout.ts");
    const { errors } = start({ sourceMaps: true });
    const t0 = Date.now();
    adapter!.captureError(thrown("dist/app.js"));
    const [e] = await until(errors);
    expect(e!.frames![0]).toEqual({ file: "src/checkout.ts", line: 13, col: 1, fn: "applyDiscount" });
    expect(e!.client_ts).toBeGreaterThanOrEqual(t0);
    expect(e!.client_ts).toBeLessThanOrEqual(t0 + 50);
    expect(warnings).toEqual([]);
  });

  it("compiled frames and no map: sent as they are, with one hint", async () => {
    compiled("app", "../src/checkout.ts", { noMap: true });
    const { errors } = start({ sourceMaps: true });
    adapter!.captureError(thrown("dist/app.js"));
    adapter!.captureError(thrown("dist/app.js", 4));
    const es = await until(errors, 2);
    expect(es.map((e) => e.frames![0]!.file)).toEqual(["dist/app.js", "dist/app.js"]);
    expect(warnings).toEqual(["stack frames point at compiled files (dist/, .next/, build/) and no source map was found next to them; build with source maps (README, \"Source maps\")"]);
  });

  it("off by default: no map is read; compiled frames get one hint naming ABIGAAIL_SOURCE_MAPS", async () => {
    compiled("app", "../src/checkout.ts");
    const { errors } = start();
    adapter!.captureError(thrown("dist/app.js"));
    adapter!.captureError(thrown("dist/app.js"));
    const es = await errors();
    expect(es.map((e) => e.frames![0]!.file)).toEqual(["dist/app.js", "dist/app.js"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/set ABIGAAIL_SOURCE_MAPS=1/);
  });

  it("ABIGAAIL_SOURCE_MAPS=off wins over the option", () => {
    expect(sourceMapsWanted(true, { ABIGAAIL_SOURCE_MAPS: "off" })).toBe(false);
    expect(sourceMapsWanted(undefined, { ABIGAAIL_SOURCE_MAPS: "1" })).toBe(true);
    expect(sourceMapsWanted(undefined, {})).toBe(false);
    expect(sourceMapsWanted(true, {})).toBe(true);
  });

  it("profile frames are mapped with the maps loaded", async () => {
    compiled("app", "../src/app.ts");
    const m = mapper();
    await m.load(["dist/app.js"]);
    const cf = { functionName: "render", url: `file://${join(root, "dist/app.js")}`, lineNumber: 4, columnNumber: 0 };
    expect(profileFrame(cf, root, m)).toEqual({ file: "src/app.ts", line: 15, fn: "render" });
    expect(profileFrame(cf, root)).toEqual({ file: "dist/app.js", line: 5, fn: "render" });
  });
});
