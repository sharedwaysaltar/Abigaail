// Dashboard users, sessions and their audit log, in their own database file
// (data/auth.db). The dashboard opens the monitoring database read-only, so a
// compromised dashboard can write here but never into monitoring data.
//
// Nothing here holds a raw session token (only its SHA-256), a password (only
// a scrypt hash), a plain TOTP secret (sealed with ABIGAAIL_DASHBOARD_SECRET),
// an IP address or a user agent.

import type { DatabaseSync } from "node:sqlite";
import { openWritable } from "./store.js";
import { checkpointTruncate, convertToIncremental, incrementalVacuum, type VacuumConversion } from "./vacuum.js";

const AUTH_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    pass_hash      TEXT NOT NULL,
    -- Sealed (AES-256-GCM) with a key from ABIGAAIL_DASHBOARD_SECRET.
    totp_sealed    TEXT NOT NULL,
    -- Last TOTP step accepted: a code is never accepted twice.
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    -- NULL until the user proved their authenticator works (a code at enrolment).
    activated_at   INTEGER,
    created_at     INTEGER NOT NULL,
    disabled_at    INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  -- Failed sign-ins per name, for the lockout. Names only, never an address.
  CREATE TABLE login_failures (
    name TEXT NOT NULL,
    ts   INTEGER NOT NULL
  );
  CREATE INDEX login_failures_name_ts ON login_failures (name, ts);

  CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY,
    ts     INTEGER NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX audit_log_ts ON audit_log (ts);
  `,
];

/** Dashboard user names: lowercase letters, digits, dots, hyphens and underscores. */
export const USER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface User {
  id: number;
  name: string;
  pass_hash: string;
  totp_sealed: string;
  totp_last_step: number;
  activated_at: number | null;
  created_at: number;
  disabled_at: number | null;
}

export interface SessionRow {
  token_hash: string;
  user_id: number;
  user_name: string;
  created_at: number;
  last_seen: number;
  /** The user's state now: a disabled or deactivated user's sessions are dead. */
  disabled_at: number | null;
  activated_at: number | null;
}

export interface AuthAuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  detail: string | null;
}

const USER_COLUMNS = "id, name, pass_hash, totp_sealed, totp_last_step, activated_at, created_at, disabled_at";

export function openAuthStore(path: string, opts: { now?: () => number } = {}): AuthStore {
  return new AuthStore(path, opts);
}

export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(readonly path: string, opts: { now?: () => number } = {}) {
    this.db = openWritable(path);
    this.now = opts.now ?? Date.now;
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < AUTH_MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(AUTH_MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  audit(actor: string, action: string, detail?: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)")
      .run(this.now(), actor, action, detail ? JSON.stringify(detail) : null);
  }

  listAudit(limit = 100): AuthAuditEntry[] {
    return this.db
      .prepare("SELECT id, ts, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as AuthAuditEntry[];
  }

  // ---- users ------------------------------------------------------------------

  userByName(name: string): User | undefined {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE name = ?`).get(name) as User | undefined;
  }

  listUsers(): User[] {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY name`).all() as unknown as User[];
  }

  /** A new user, inactive until `activateUser` (after a first valid code). */
  createUser(name: string, passHash: string, totpSealed: string, actor: string): User {
    if (!USER_NAME_RE.test(name)) throw new Error("user name must be lowercase letters, digits, '.', '-' or '_' (up to 32)");
    return this.tx(() => {
      if (this.userByName(name)) throw new Error("user already exists");
      this.db
        .prepare("INSERT INTO users (name, pass_hash, totp_sealed, created_at) VALUES (?, ?, ?, ?)")
        .run(name, passHash, totpSealed, this.now());
      this.audit(actor, "user.create", { name });
      return this.userByName(name)!;
    });
  }

  /** Mark the authenticator as proven and burn the step used to prove it. */
  activateUser(name: string, step: number, actor: string): boolean {
    return this.tx(() => {
      const { changes } = this.db
        .prepare("UPDATE users SET activated_at = ?, totp_last_step = max(totp_last_step, ?) WHERE name = ? AND disabled_at IS NULL")
        .run(this.now(), step, name);
      if (changes) this.audit(actor, "user.activate", { name });
      return changes > 0;
    });
  }

  /** New TOTP secret: the user is inactive (and signed out) until it is proven. */
  resetMfa(name: string, totpSealed: string, actor: string): boolean {
    return this.tx(() => {
      const user = this.userByName(name);
      if (!user) return false;
      this.db
        .prepare("UPDATE users SET totp_sealed = ?, totp_last_step = 0, activated_at = NULL WHERE id = ?")
        .run(totpSealed, user.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      this.audit(actor, "user.reset_mfa", { name });
      return true;
    });
  }

  disableUser(name: string, actor: string): boolean {
    return this.tx(() => {
      const user = this.userByName(name);
      if (!user || user.disabled_at !== null) return false;
      this.db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(this.now(), user.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      this.audit(actor, "user.disable", { name });
      return true;
    });
  }

  /**
   * Accept a TOTP step for a user only if it is newer than the last one
   * accepted. Atomic, so two sign-ins racing with one code cannot both pass.
   */
  useTotpStep(userId: number, step: number): boolean {
    const { changes } = this.db
      .prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?")
      .run(step, userId, step);
    return changes > 0;
  }

  // ---- lockout ----------------------------------------------------------------

  recordFailure(name: string): void {
    const t = this.now();
    this.db.prepare("INSERT INTO login_failures (name, ts) VALUES (?, ?)").run(name, t);
    // Keep the table small: only the lockout window matters.
    this.db.prepare("DELETE FROM login_failures WHERE ts < ?").run(t - 86_400_000);
  }

  /** Failures for a name since `since`, and the time of the latest. */
  failuresSince(name: string, since: number): { n: number; last: number | null } {
    const row = this.db
      .prepare("SELECT count(*) AS n, max(ts) AS last FROM login_failures WHERE name = ? AND ts >= ?")
      .get(name, since) as { n: number; last: number | null };
    return { n: Number(row.n), last: row.last };
  }

  /** Clear a name's failures (ends a lockout). Audited whether or not it was locked. */
  unlock(name: string, actor: string): number {
    return this.tx(() => {
      const { changes } = this.db.prepare("DELETE FROM login_failures WHERE name = ?").run(name);
      this.audit(actor, "user.unlock", { name, cleared: Number(changes) });
      return Number(changes);
    });
  }

  // ---- sessions -----------------------------------------------------------------

  createSession(tokenHash: string, userId: number): void {
    const t = this.now();
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)").run(tokenHash, userId, t, t);
  }

  sessionByHash(tokenHash: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT s.token_hash, s.user_id, u.name AS user_name, s.created_at, s.last_seen, u.disabled_at, u.activated_at
                FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
      .get(tokenHash) as SessionRow | undefined;
  }

  touchSession(tokenHash: string): void {
    this.db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(this.now(), tokenHash);
  }

  deleteSession(tokenHash: string): boolean {
    return this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash).changes > 0;
  }

  /** Remove sessions idle since before `idleBefore` or created before `createdBefore`. */
  purgeSessions(idleBefore: number, createdBefore: number): number {
    return Number(
      this.db.prepare("DELETE FROM sessions WHERE last_seen < ? OR created_at < ?").run(idleBefore, createdBefore).changes,
    );
  }

  /**
   * Retention (run by the server, DECISIONS #88): expired sessions, sign-in
   * failures past the lockout's 24 h, and audit entries older than
   * `auditBefore`. Returns the rows deleted per kind.
   */
  prune(opts: { idleBefore: number; createdBefore: number; failuresBefore: number; auditBefore: number }): { sessions: number; audit: number } {
    return this.tx(() => {
      const sessions = this.purgeSessions(opts.idleBefore, opts.createdBefore);
      this.db.prepare("DELETE FROM login_failures WHERE ts < ?").run(opts.failuresBefore);
      const audit = Number(this.db.prepare("DELETE FROM audit_log WHERE ts < ?").run(opts.auditBefore).changes);
      return { sessions, audit };
    });
  }

  /**
   * Move WAL contents into the main file and truncate the WAL. busy: a reader
   * stopped it; try again. noWait: do not wait for readers (retention retries later).
   */
  checkpoint(opts: { noWait?: boolean } = {}): { busy: boolean } {
    return checkpointTruncate(this.db, opts);
  }

  /** One-time switch to incremental auto_vacuum when disk allows (see vacuum.ts). */
  convertToIncremental(opts: { freeBytes?: (dir: string) => number } = {}): VacuumConversion {
    return convertToIncremental(this.db, this.path, opts);
  }

  /** Return up to `pages` free pages to the filesystem; returns the free pages left. */
  incrementalVacuum(pages: number): number {
    return incrementalVacuum(this.db, pages);
  }

  /** For tests and audits: every stored session hash. */
  sessionHashes(): string[] {
    return (this.db.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[]).map((r) => r.token_hash);
  }
}
