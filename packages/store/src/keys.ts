import { createHash, randomBytes } from "node:crypto";

/** Fixed prefix so leaked keys are recognisable (e.g. by a secrets scanner). */
export const INGEST_KEY_PREFIX = "abk_";
export const INGEST_KEY_RE = /^abk_[A-Za-z0-9_-]{43}$/;

/** A new write-only ingest key: "abk_" + 32 random bytes, base64url. */
export function generateIngestKey(): string {
  return INGEST_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** What the store keeps instead of the key. */
export function hashIngestKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
