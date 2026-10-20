// The simulator only ever targets demo apps on this machine, and only ever
// writes inside data/sim/.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTarget, connectAddress, resetSim, simPaths } from "@abigaail/sim";

describe("assertLocalTarget", () => {
  it.each(["http://127.0.0.1:3001/", "http://localhost:3000/user/1", "http://[::1]:4318/ingest", "http://LOCALHOST:3001"])("allows %s", (url) => {
    expect(() => assertLocalTarget(url)).not.toThrow();
  });

  it.each([
    "https://127.0.0.1:3001/",
    "http://example.com:3001/",
    "http://192.0.2.10:3001/",
    "http://10.0.0.5:3001/",
    "http://localhost.example:3001/",
    "http://127.0.0.1.nip.io:3001/",
    "http://localhost.:3001/",
    "http://localhost@example.com:3001/",
    "http://user:pw@127.0.0.1:3001/",
    "http://127.0.0.1/",
    "ftp://127.0.0.1:21/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertLocalTarget(url)).toThrow(/refusing/);
  });

  it("connects to the literal loopback address, never through DNS", () => {
    expect(connectAddress(assertLocalTarget("http://localhost:3001/"))).toBe("127.0.0.1");
    expect(connectAddress(assertLocalTarget("http://[::1]:3001/"))).toBe("::1");
  });
});

describe("data/sim paths", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "abigaail-simpaths-"));
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "abigaail.db"), "the real database");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("puts every file inside data/sim/", () => {
    const p = simPaths(root);
    for (const f of [p.db, p.salt, p.authDb, p.log, p.report]) expect(f.startsWith(join(root, "data", "sim") + "/")).toBe(true);
  });

  it("refuses a symlink in data/sim/ pointing at the real database", () => {
    mkdirSync(join(root, "data", "sim"));
    symlinkSync(join(root, "data", "abigaail.db"), join(root, "data", "sim", "abigaail.db"));
    expect(() => simPaths(root)).toThrow(/outside data\/sim/);
  });

  it("refuses a dangling symlink (opening it would create its target elsewhere)", () => {
    mkdirSync(join(root, "data", "sim"));
    symlinkSync(join(root, "elsewhere.db"), join(root, "data", "sim", "abigaail.db"));
    expect(() => simPaths(root)).toThrow(/symlink/);
  });

  it("refuses data/sim itself being a symlink, even to inside data/", () => {
    symlinkSync(join(root, "data"), join(root, "data", "sim"));
    expect(() => simPaths(root)).toThrow(/not a symlink/);
    expect(() => resetSim(root)).toThrow(/not a symlink/);
    expect(existsSync(join(root, "data", "abigaail.db"))).toBe(true);
  });

  it("reset deletes data/sim/ and nothing else", () => {
    mkdirSync(join(root, "data", "sim"));
    writeFileSync(join(root, "data", "sim", "abigaail.db"), "sim");
    resetSim(root);
    expect(existsSync(join(root, "data", "sim"))).toBe(false);
    expect(existsSync(join(root, "data", "abigaail.db"))).toBe(true);
  });
});
