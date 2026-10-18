import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "@abigaail/server";
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

const saltDays = () => {
  const db = new DatabaseSync(join(dir, "test.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT day FROM salts").all() as { day: string }[]).map((r) => r.day);
  } finally {
    db.close();
  }
};

it("rotates the salt at UTC midnight with no requests, and keeps doing so daily", () => {
  store.saltFor("2026-10-18");
  const server = createServer({ store, log: () => {} });
  try {
    vi.advanceTimersByTime(59_000);
    expect(saltDays()).toEqual(["2026-10-18"]);
    vi.advanceTimersByTime(1_000);
    expect(saltDays()).toEqual(["2026-10-19"]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(saltDays()).toEqual(["2026-10-20"]);
  } finally {
    server.close();
  }
});
