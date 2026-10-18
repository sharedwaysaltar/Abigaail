import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base32Decode, totpCode, totpStep } from "@abigaail/auth";
import { runUserCommand, type UserCliDeps } from "@abigaail/server";
import { openAuthStore } from "@abigaail/store";

const ENV = { ABIGAAIL_DASHBOARD_SECRET: Buffer.alloc(32, 3).toString("base64") };
let dir: string;
let dbPath: string;
let printed: string[];
const now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abigaail-users-"));
  dbPath = join(dir, "auth.db");
  printed = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Answers prompts in order; a function answer sees what was printed so far (to read the secret). */
function deps(answers: (string | (() => string))[], env: NodeJS.ProcessEnv = ENV): UserCliDeps {
  const queue = [...answers];
  return {
    env,
    authDbPath: dbPath,
    now: () => now,
    print: (l) => printed.push(l),
    prompt: async () => {
      const a = queue.shift();
      if (a === undefined) throw new Error("unexpected prompt");
      return typeof a === "function" ? a() : a;
    },
  };
}

const PASSWORD = "a long enough password";
const codeFromPrinted = () => {
  const secret = printed.find((l) => l.includes("Secret:"))!.split("Secret:")[1]!.trim();
  return totpCode(base32Decode(secret), totpStep(now));
};

describe("user CLI", () => {
  it("refuses to run without ABIGAAIL_DASHBOARD_SECRET, before opening anything", async () => {
    await expect(runUserCommand("create", "owner", deps([PASSWORD, PASSWORD], {}))).rejects.toThrow(/ABIGAAIL_DASHBOARD_SECRET/);
    await expect(runUserCommand("unlock", "owner", deps([], {}))).rejects.toThrow(/ABIGAAIL_DASHBOARD_SECRET/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("creates a user who stays inactive until a code from the authenticator matches", async () => {
    await runUserCommand("create", "owner", deps([PASSWORD, PASSWORD, "000000", codeFromPrinted]));
    const store = openAuthStore(dbPath);
    const user = store.userByName("owner")!;
    expect(user.activated_at).not.toBeNull();
    expect(user.pass_hash).not.toContain(PASSWORD);
    expect(store.listAudit().map((a) => [a.actor, a.action])).toEqual([["cli", "user.activate"], ["cli", "user.create"]]);
    store.close();
  });

  it("refuses mismatched passwords and short passwords", async () => {
    await expect(runUserCommand("create", "owner", deps([PASSWORD, `${PASSWORD}!`]))).rejects.toThrow(/do not match/);
    await expect(runUserCommand("create", "owner", deps(["short", "short"]))).rejects.toThrow(/at least 12/);
  });

  it("leaves the user inactive after three wrong codes", async () => {
    await expect(runUserCommand("create", "owner", deps([PASSWORD, PASSWORD, "1", "2", "3"]))).rejects.toThrow(/inactive/);
    const store = openAuthStore(dbPath);
    expect(store.userByName("owner")!.activated_at).toBeNull();
    store.close();
  });

  it("unlock clears a lockout and is audited", async () => {
    await runUserCommand("create", "owner", deps([PASSWORD, PASSWORD, codeFromPrinted]));
    const store = openAuthStore(dbPath);
    for (let i = 0; i < 10; i++) store.recordFailure("owner");
    store.close();
    await runUserCommand("unlock", "owner", deps([]));
    const after = openAuthStore(dbPath);
    expect(after.failuresSince("owner", 0).n).toBe(0);
    expect(after.listAudit()[0]).toMatchObject({ actor: "cli", action: "user.unlock" });
    after.close();
  });
});
