import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, openSaltFile } from "@abigaail/server";
import { openStore, type Store } from "@abigaail/store";

let dir: string;
let store: Store;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 18, 23, 59, 0), toFake: ["setTimeout", "clearTimeout", "Date"] });
  dir = mkdtempSync(join(tmpdir(), "abigaail-rotation-"));
  store = openStore(join(dir, "test.db"));
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("rotates salt.bin at UTC midnight with no requests, and keeps doing so daily", () => {
  const path = join(dir, "salt.bin");
  const salt = openSaltFile(path);
  const file = () => readFileSync(path);
  const before = file();
  expect(before.toString("latin1", 0, 10)).toBe("2026-10-18");
  const oldSalt = Buffer.from(before.subarray(10, 42));

  const server = createServer({ store, salt, log: () => {} });
  try {
    vi.advanceTimersByTime(59_000);
    expect(file().equals(before)).toBe(true);

    vi.advanceTimersByTime(1_000);
    const after = file();
    expect(after.toString("latin1", 0, 10)).toBe("2026-10-19");
    expect(after.includes(oldSalt)).toBe(false);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(file().toString("latin1", 0, 10)).toBe("2026-10-20");
  } finally {
    server.close();
  }
});
