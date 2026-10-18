import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSaltFile, SALT_FILE_BYTES, visitorHash } from "@abigaail/server";

const DAY1 = Date.UTC(2026, 9, 18, 12);
const DAY2 = Date.UTC(2026, 9, 19, 12);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-salt-"));
  path = join(dir, "data", "salt.bin");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const header = () => readFileSync(path).toString("latin1", 0, 10);
const saltBytes = () => Buffer.from(readFileSync(path).subarray(10, SALT_FILE_BYTES));
const mode = () => statSync(path).mode & 0o777;

describe("salt file", () => {
  it("creates a 42-byte file: UTC day then 32 random bytes", () => {
    const s = openSaltFile(path, () => DAY1);
    expect(readFileSync(path)).toHaveLength(42);
    expect(header()).toBe("2026-10-18");
    expect(s.forDay("2026-10-18").equals(saltBytes())).toBe(true);
  });

  it("gives the same salt for the same day across a restart", () => {
    const first = Buffer.from(openSaltFile(path, () => DAY1).forDay("2026-10-18"));
    const again = openSaltFile(path, () => DAY1 + 3600_000).forDay("2026-10-18");
    expect(again.equals(first)).toBe(true);
  });

  it("rotates at startup when the file holds an earlier day", () => {
    const first = Buffer.from(openSaltFile(path, () => DAY1).forDay("2026-10-18"));
    openSaltFile(path, () => DAY2);
    expect(header()).toBe("2026-10-19");
    expect(saltBytes().equals(first)).toBe(false);
  });

  it("overwrites in place: same inode, old bytes gone, nothing truncated", () => {
    openSaltFile(path, () => DAY1);
    // Bytes past 42 are ignored, and must survive rotation (proves no truncation).
    writeFileSync(path, "TRAILER!", { flag: "a" });
    const old = saltBytes();
    const inode = statSync(path).ino;

    const s = openSaltFile(path, () => DAY1);
    expect(s.forDay("2026-10-18").equals(old)).toBe(true);
    s.forDay("2026-10-19");

    const bytes = readFileSync(path);
    expect(statSync(path).ino).toBe(inode);
    expect(bytes.includes(old)).toBe(false);
    expect(bytes.toString("latin1", 0, 10)).toBe("2026-10-19");
    expect(bytes.toString("latin1", 42)).toBe("TRAILER!");
  });

  it("is created with mode 0600 and tightened back to 0600 if loosened", () => {
    openSaltFile(path, () => DAY1);
    expect(mode()).toBe(0o600);
    chmodSync(path, 0o644);
    openSaltFile(path, () => DAY1);
    expect(mode()).toBe(0o600);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["partial", Buffer.from("2026-10-18abcdefghij")],
    ["bad date", Buffer.concat([Buffer.from("2026-13-45"), Buffer.alloc(32, 7)])],
    ["not a date", Buffer.concat([Buffer.from("hello-worl"), Buffer.alloc(32, 7)])],
    ["zeroed salt", Buffer.concat([Buffer.from("2026-10-18"), Buffer.alloc(32, 0)])],
  ])("regenerates a corrupt file (%s)", (_label, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    const salt = openSaltFile(path, () => DAY1).forDay("2026-10-18");
    expect(header()).toBe("2026-10-18");
    expect(saltBytes().equals(salt)).toBe(true);
    expect(salt.every((b) => b === 0)).toBe(false);
    expect(salt.equals(Buffer.alloc(32, 7))).toBe(false);
  });
});

describe("salt buffers in memory", () => {
  it("zeroes a buffer handed out before rotation; later hashes use the new salt", () => {
    const s = openSaltFile(path, () => DAY1);
    const held = s.forDay("2026-10-18");
    const oldCopy = Buffer.from(held);
    const fresh = s.forDay("2026-10-19");
    expect(held.every((b) => b === 0)).toBe(true);
    expect(fresh.equals(saltBytes())).toBe(true);
    expect(visitorHash(fresh, "app", "203.0.113.77", "ua")).not.toBe(visitorHash(oldCopy, "app", "203.0.113.77", "ua"));
  });

  it.skipIf(process.getuid?.() === 0)("never serves a stale salt when rotation cannot write", () => {
    const s = openSaltFile(path, () => DAY1);
    const held = s.forDay("2026-10-18");
    chmodSync(path, 0o400);
    expect(() => s.forDay("2026-10-19")).toThrow();
    expect(held.every((b) => b === 0)).toBe(true);
    // Still no salt for the new day, and the old one is not offered as a fallback.
    expect(() => s.forDay("2026-10-19")).toThrow();
    chmodSync(path, 0o600);
    expect(s.forDay("2026-10-19").equals(saltBytes())).toBe(true);
  });
});
