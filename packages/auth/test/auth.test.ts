import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH,
  Authenticator,
  base32Decode,
  base32Encode,
  hashPassword,
  hashToken,
  newTotpSecret,
  SecretKey,
  Throttle,
  totpCode,
  totpStep,
  verifyPassword,
  verifyTotp,
} from "@abigaail/auth";
import { openAuthStore, type AuthStore } from "@abigaail/store";

const KEY_ENV = { ABIGAAIL_DASHBOARD_SECRET: Buffer.alloc(32, 7).toString("base64") };

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; 6-digit codes are the last 6 digits.
  const secret = Buffer.from("12345678901234567890");
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i gives %s", (t, code) => {
    expect(totpCode(secret, Math.floor(t / 30))).toBe(code);
  });

  it("base32 round-trips", () => {
    const b = Buffer.from("12345678901234567890");
    expect(base32Encode(b)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });

  it("accepts one step either side, never two, and never a used step", () => {
    const s = newTotpSecret();
    const now = 1_800_000_000_000;
    const t = totpStep(now);
    const code = (step: number) => totpCode(base32Decode(s), step);
    expect(verifyTotp(s, code(t), now, 0)).toBe(t);
    expect(verifyTotp(s, code(t - 1), now, 0)).toBe(t - 1);
    expect(verifyTotp(s, code(t + 1), now, 0)).toBe(t + 1);
    expect(verifyTotp(s, code(t - 2), now, 0)).toBeUndefined();
    expect(verifyTotp(s, code(t), now, t)).toBeUndefined();
    expect(verifyTotp(s, "12345", now, 0)).toBeUndefined();
    expect(verifyTotp(s, "abcdef", now, 0)).toBeUndefined();
  });
});

describe("passwords", () => {
  it("verifies the right password only, and refuses short ones", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow(/at least 12/);
  });
});

describe("SecretKey", () => {
  it("refuses a missing or short secret without echoing it", () => {
    expect(() => SecretKey.fromEnv({})).toThrow(/ABIGAAIL_DASHBOARD_SECRET is not set/);
    try {
      SecretKey.fromEnv({ ABIGAAIL_DASHBOARD_SECRET: "c2hvcnQ=" });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("c2hvcnQ");
    }
  });

  it("opens only what it sealed, for the same user, with the same key", () => {
    const k = SecretKey.fromEnv(KEY_ENV);
    const box = k.seal("JBSWY3DPEHPK3PXP", "owner");
    expect(box).not.toContain("JBSWY3DPEHPK3PXP");
    expect(k.open(box, "owner")).toBe("JBSWY3DPEHPK3PXP");
    expect(k.open(box, "mallory")).toBeUndefined();
    const parts = box.split(".");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(k.open(parts.join("."), "owner")).toBeUndefined();
    const other = SecretKey.fromEnv({ ABIGAAIL_DASHBOARD_SECRET: Buffer.alloc(32, 8).toString("base64") });
    expect(other.open(box, "owner")).toBeUndefined();
  });
});

describe("Throttle", () => {
  it("spends a burst, refills over time and keeps keys apart", () => {
    let t = 0;
    const th = new Throttle(2, 1000, () => t);
    expect([th.take("a"), th.take("a"), th.take("a")]).toEqual([true, true, false]);
    expect(th.take("b")).toBe(true);
    t += 1000;
    expect(th.take("a")).toBe(true);
    expect(th.take("a")).toBe(false);
  });

  it("is bounded", () => {
    const th = new Throttle(1, 1000, () => 0, 3);
    for (const k of ["a", "b", "c", "d", "e"]) th.take(k);
    expect(th.size).toBe(3);
  });
});

describe("Authenticator", () => {
  let dir: string;
  let store: AuthStore;
  let now: number;
  let auth: Authenticator;
  let secret: string;
  const key = SecretKey.fromEnv(KEY_ENV);
  const PASSWORD = "a long enough password";
  const code = (at = now) => totpCode(base32Decode(secret), totpStep(at));
  // A fresh address per attempt, unless a test is about the address throttle.
  let addr = 0;
  const attempt = (over: Partial<{ name: string; password: string; code: string; address: string }> = {}) =>
    auth.signIn({ name: "owner", password: PASSWORD, code: code(), address: `10.0.0.${++addr}`, ...over });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "abigaail-auth-"));
    now = 1_800_000_000_000;
    store = openAuthStore(join(dir, "auth.db"), { now: () => now });
    auth = new Authenticator(store, key, { now: () => now });
    secret = newTotpSecret();
    store.createUser("owner", await hashPassword(PASSWORD), key.seal(secret, "owner"), "test");
    store.activateUser("owner", 0, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const actions = () => store.listAudit().map((a) => `${a.action}${a.detail ? ` ${JSON.parse(a.detail).reason ?? ""}`.trimEnd() : ""}`);

  it("signs in with name, password and code; stores only the token's hash", async () => {
    const r = await attempt();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.sessionHashes()).toEqual([hashToken(r.token)]);
    const file = readFileSync(join(dir, "auth.db"));
    expect(file.includes(Buffer.from(r.token))).toBe(false);
    expect(file.includes(Buffer.from(secret))).toBe(false);
    expect(auth.session(r.token)?.user).toBe("owner");
    expect(actions()[0]).toBe("login.ok");
  });

  it("every failure gives the same answer to the caller and its reason to the audit log", async () => {
    store.createUser("ghost", await hashPassword(PASSWORD), key.seal(secret, "ghost"), "test"); // never activated
    const results = [
      await attempt({ name: "nobody" }),
      await attempt({ password: "wrong password!!" }),
      await attempt({ code: "000000" === code() ? "111111" : "000000" }),
      await attempt({ name: "ghost" }),
    ];
    for (const r of results) expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(actions().slice(0, 4).reverse()).toEqual([
      "login.failed unknown_user",
      "login.failed bad_password",
      "login.failed bad_code",
      "login.failed inactive",
    ]);
    expect(store.sessionHashes()).toEqual([]);
  });

  it("a right password with no code, or a code with the wrong password, is refused", async () => {
    expect((await attempt({ code: "" })).ok).toBe(false);
    expect((await attempt({ password: "not the password" })).ok).toBe(false);
    expect(store.sessionHashes()).toEqual([]);
  });

  it("a code works once: a replay is refused and audited as such", async () => {
    const c = code();
    expect((await attempt({ code: c })).ok).toBe(true);
    const again = await attempt({ code: c });
    expect(again).toEqual({ ok: false, reason: "replayed_code" });
    expect(actions()[0]).toBe("login.failed replayed_code");
  });

  it("accepting a step is atomic: two sign-ins racing with one code cannot both pass", async () => {
    const user = store.userByName("owner")!;
    const step = totpStep(now);
    expect(store.useTotpStep(user.id, step)).toBe(true);
    expect(store.useTotpStep(user.id, step)).toBe(false);
    expect(store.useTotpStep(user.id, step - 1)).toBe(false);
    expect(store.useTotpStep(user.id, step + 1)).toBe(true);
  });

  it("a disabled user cannot sign in, and their sessions end", async () => {
    const r = await attempt();
    if (!r.ok) throw new Error("expected sign-in");
    store.disableUser("owner", "test");
    expect(auth.session(r.token)).toBeUndefined();
    now += 30_000;
    expect(await attempt()).toEqual({ ok: false, reason: "disabled" });
  });

  it("locks a name after 10 failures in 15 min, until it expires or user:unlock", async () => {
    for (let i = 0; i < AUTH.lockoutFailures; i++) await attempt({ password: "wrong password!!" });
    expect(await attempt()).toEqual({ ok: false, reason: "locked" });
    expect(actions()[0]).toBe("login.locked");
    expect(store.unlock("owner", "cli")).toBe(AUTH.lockoutFailures);
    expect(actions()[0]).toBe("user.unlock");
    expect((await attempt()).ok).toBe(true);
  });

  it("the lockout ends by itself 15 min after the last failure", async () => {
    for (let i = 0; i < AUTH.lockoutFailures; i++) await attempt({ password: "wrong password!!" });
    now += AUTH.lockoutMs;
    expect((await attempt()).ok).toBe(true);
  });

  it("one address is throttled before it can lock the name, and throttled tries are not counted", async () => {
    const address = "203.0.113.9";
    // The attacker keeps trying from one address for a whole lockout window.
    let tries = 0;
    for (let t = 0; t <= AUTH.lockoutWindowMs; t += 10_000) {
      now = 1_800_000_000_000 + t;
      const r = await attempt({ password: "wrong password!!", address });
      if (r.ok || r.reason !== "throttled") tries++;
    }
    expect(tries).toBeLessThan(AUTH.lockoutFailures);
    // The owner, from elsewhere, still gets in.
    expect((await attempt({ address: "198.51.100.1" })).ok).toBe(true);
    // Nothing about addresses was stored.
    const file = readFileSync(join(dir, "auth.db"));
    expect(file.includes(Buffer.from(address))).toBe(false);
    expect(file.includes(Buffer.from("10.0.0."))).toBe(false);
  });

  it("sessions expire after 2 h idle and after 12 h in any case; sign-out ends one", async () => {
    const a = await attempt();
    if (!a.ok) throw new Error("expected sign-in");
    now += AUTH.sessionIdleMs + 1;
    expect(auth.session(a.token)).toBeUndefined();
    expect(store.sessionHashes()).toEqual([]);

    now += 60_000;
    const b = await attempt();
    if (!b.ok) throw new Error("expected sign-in");
    for (let h = 0; h < 12; h++) {
      now += 3_600_000;
      if (h < 11) expect(auth.session(b.token)?.user).toBe("owner");
    }
    now += 1;
    expect(auth.session(b.token)).toBeUndefined();

    now += 60_000;
    const c = await attempt();
    if (!c.ok) throw new Error("expected sign-in");
    auth.signOut(c.token);
    expect(auth.session(c.token)).toBeUndefined();
    expect(actions()[0]).toBe("logout");
  });

  it("refuses odd tokens without a lookup", () => {
    expect(auth.session(undefined)).toBeUndefined();
    expect(auth.session("x".repeat(500))).toBeUndefined();
  });
});
