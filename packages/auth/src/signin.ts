// Sign-in and session rules. One answer for every failure, so the form never
// says whether a name exists, which factor was wrong, or that it is locked.
// The reason is written to the auth audit log only.

import { createHash, randomBytes } from "node:crypto";
import type { AuthStore, SessionRow } from "@abigaail/store";
import { dummyHash, verifyPassword } from "./password.js";
import type { SecretKey } from "./secret.js";
import { Throttle } from "./throttle.js";
import { totpStep, verifyTotp } from "./totp.js";

const MIN = 60_000;

export const AUTH = {
  /** Failures per name within lockoutWindowMs that lock it... */
  lockoutFailures: 10,
  lockoutWindowMs: 15 * MIN,
  /** ...for this long after the last failure. `user:unlock` ends it early. */
  lockoutMs: 15 * MIN,
  /**
   * Per source address: 5 attempts at once, one back every 4 min. Over a
   * lockout window one address gets at most 5 + 15/4 < 10 tries, so a single
   * address cannot lock anyone out.
   */
  addressBurst: 5,
  addressRefillMs: 4 * MIN,
  /** All addresses together. */
  globalBurst: 30,
  globalRefillMs: 2_000,
  sessionIdleMs: 2 * 60 * MIN,
  sessionMaxMs: 12 * 60 * MIN,
  /** last_seen is written at most this often. */
  touchEveryMs: MIN,
};

export type SignInFailure = "throttled" | "locked" | "unknown_user" | "bad_password" | "bad_code" | "replayed_code" | "inactive" | "disabled" | "bad_secret";

export type SignInResult = { ok: true; token: string; user: string } | { ok: false; reason: SignInFailure };

/** What the form shows for any failure. */
export const SIGN_IN_FAILED = "Sign-in failed. Check your name, password and code.";

/** SHA-256 of a session token: the only form stored. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface SignInInput {
  name: string;
  password: string;
  code: string;
  /** Socket address of the request, for the in-memory throttle only. Never stored or logged. */
  address: string;
}

export class Authenticator {
  private readonly perAddress: Throttle;
  private readonly global: Throttle;
  private readonly now: () => number;

  constructor(
    private readonly store: AuthStore,
    private readonly key: SecretKey,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.perAddress = new Throttle(AUTH.addressBurst, AUTH.addressRefillMs, this.now);
    this.global = new Throttle(AUTH.globalBurst, AUTH.globalRefillMs, this.now);
  }

  async signIn(input: SignInInput): Promise<SignInResult> {
    // Throttled attempts are refused before any lookup and are not counted
    // against the name: that is what keeps an attacker from locking it.
    if (!this.perAddress.take(input.address) || !this.global.take("*")) return { ok: false, reason: "throttled" };

    const name = input.name.trim().toLowerCase().slice(0, 64);
    const user = this.store.userByName(name);
    // Always pay for one scrypt, so an unknown name answers as slowly as a known one.
    const passwordOk = await verifyPassword(input.password, user?.pass_hash ?? (await dummyHash()));

    const fail = (reason: SignInFailure): SignInResult => {
      if (reason === "locked") {
        this.store.audit(name || "-", "login.locked");
      } else {
        this.store.recordFailure(name);
        this.store.audit(name || "-", "login.failed", { reason });
      }
      return { ok: false, reason };
    };

    const t = this.now();
    const failures = this.store.failuresSince(name, t - AUTH.lockoutWindowMs);
    if (failures.n >= AUTH.lockoutFailures && failures.last !== null && t - failures.last < AUTH.lockoutMs) return fail("locked");
    if (!user) return fail("unknown_user");
    if (!passwordOk) return fail("bad_password");
    if (user.disabled_at !== null) return fail("disabled");
    if (user.activated_at === null) return fail("inactive");
    const secret = this.key.open(user.totp_sealed, user.name);
    if (secret === undefined) return fail("bad_secret");
    const step = verifyTotp(secret, input.code.replace(/\s/g, ""), t, user.totp_last_step);
    if (step === undefined) {
      // Distinguish a replay in the audit log: the code was right, just used.
      const replay = verifyTotp(secret, input.code.replace(/\s/g, ""), t, -1) !== undefined;
      return fail(replay ? "replayed_code" : "bad_code");
    }
    if (!this.store.useTotpStep(user.id, step)) return fail("replayed_code");

    const token = randomBytes(32).toString("base64url");
    this.store.createSession(hashToken(token), user.id);
    this.store.purgeSessions(t - AUTH.sessionIdleMs, t - AUTH.sessionMaxMs);
    this.store.audit(user.name, "login.ok");
    return { ok: true, token, user: user.name };
  }

  /** The signed-in user for a cookie token, or undefined. Expired sessions are deleted. */
  session(token: string | undefined): { user: string; session: SessionRow } | undefined {
    if (!token || token.length > 128) return undefined;
    const hash = hashToken(token);
    const s = this.store.sessionByHash(hash);
    if (!s) return undefined;
    const t = this.now();
    if (s.disabled_at !== null || s.activated_at === null || t - s.last_seen > AUTH.sessionIdleMs || t - s.created_at > AUTH.sessionMaxMs) {
      this.store.deleteSession(hash);
      return undefined;
    }
    if (t - s.last_seen >= AUTH.touchEveryMs) this.store.touchSession(hash);
    return { user: s.user_name, session: s };
  }

  /**
   * The same rules as session(), but read-only: never refreshes last_seen and
   * never deletes. For checks that are not the user's own activity (an open
   * Live stream re-checking its session), so they cannot extend the idle timeout.
   */
  peekSession(token: string | undefined): { user: string; session: SessionRow } | undefined {
    if (!token || token.length > 128) return undefined;
    const s = this.store.sessionByHash(hashToken(token));
    if (!s) return undefined;
    const t = this.now();
    if (s.disabled_at !== null || s.activated_at === null || t - s.last_seen > AUTH.sessionIdleMs || t - s.created_at > AUTH.sessionMaxMs) return undefined;
    return { user: s.user_name, session: s };
  }

  signOut(token: string | undefined): void {
    if (!token || token.length > 128) return;
    const s = this.store.sessionByHash(hashToken(token));
    if (s && this.store.deleteSession(hashToken(token))) this.store.audit(s.user_name, "logout");
  }
}

/** For the CLI: the step a fresh code proves, during enrolment. */
export function enrolmentStep(secretBase32: string, code: string, now = Date.now()): number | undefined {
  return verifyTotp(secretBase32, code.replace(/\s/g, ""), now, totpStep(now) - 2);
}
