// RFC 6238 TOTP: HMAC-SHA1, 30-second steps, 6 digits, the format every
// authenticator app accepts. Codes one step either side are accepted, and a
// step is only ever used once (the caller stores the last used step).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_MS = 30_000;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps take). */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpStep = (now: number): number => Math.floor(now / TOTP_STEP_MS);

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, "0");
}

/**
 * The step a code matches (now, one before or one after), or undefined. Steps
 * at or before `lastUsedStep` never match, so a code cannot be replayed.
 */
export function verifyTotp(secretBase32: string, code: string, now: number, lastUsedStep: number): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const secret = base32Decode(secretBase32);
  const t = totpStep(now);
  let match: number | undefined;
  // Check all three steps whatever happens, so timing says nothing about which matched.
  for (const step of [t - 1, t, t + 1]) {
    const ok = timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code));
    if (ok && step > lastUsedStep && match === undefined) match = step;
  }
  return match;
}

/** otpauth:// URI for authenticator apps. Holds the secret: show once, never log. */
export function otpauthUri(user: string, secretBase32: string): string {
  const label = encodeURIComponent(`Abigaail:${user}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=Abigaail&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_MS / 1000}`;
}
