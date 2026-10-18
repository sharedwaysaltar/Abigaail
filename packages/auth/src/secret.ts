// TOTP secrets are stored encrypted (AES-256-GCM) with a key derived from
// ABIGAAIL_DASHBOARD_SECRET, which lives only in the environment. The CLI that
// creates users and the dashboard that checks codes must share it.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const SECRET_ENV = "ABIGAAIL_DASHBOARD_SECRET";

export class SecretKey {
  private constructor(private readonly key: Buffer) {}

  /**
   * From the env value: base64 or base64url of at least 32 random bytes
   * (e.g. `openssl rand -base64 32`). Throws a message without the value.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretKey {
    const raw = env[SECRET_ENV];
    if (!raw) throw new Error(`${SECRET_ENV} is not set (generate one with: openssl rand -base64 32)`);
    const bytes = Buffer.from(raw.trim(), "base64");
    if (bytes.length < 32) throw new Error(`${SECRET_ENV} must be at least 32 random bytes, base64 (openssl rand -base64 32)`);
    return new SecretKey(Buffer.from(hkdfSync("sha256", bytes, Buffer.alloc(0), "abigaail totp secret v1", 32)));
  }

  /** `v1.iv.ciphertext.tag`. `context` (the user name) is bound in, so a row cannot be moved to another user. */
  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }

  /** The plaintext, or undefined if the box was tampered with, sealed for another context or with another key. */
  open(sealed: string, context: string): string | undefined {
    const [v, iv, ct, tag] = sealed.split(".");
    if (v !== "v1" || !iv || !ct || !tag) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }
}
