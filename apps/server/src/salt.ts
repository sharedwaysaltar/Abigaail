// The daily visitor-hash salt, kept in its own small file and never in the
// database, so neither the WAL nor a database backup can ever hold it.
//
// File format: exactly 42 bytes at offset 0: the UTC day as 10 ASCII bytes
// ("YYYY-MM-DD") followed by 32 random bytes. Anything after byte 42 is ignored.
// Rotation overwrites those 42 bytes in place (open r+, write at offset 0,
// fsync): the file is never truncated or replaced, so the old salt's blocks are
// overwritten rather than left behind as an orphaned file.

import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { utcDay } from "./derive.js";

const DAY_BYTES = 10;
const SALT_BYTES = 32;
export const SALT_FILE_BYTES = DAY_BYTES + SALT_BYTES;
const MODE = 0o600;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Where a salt comes from. The server depends on this, not on the file. */
export interface SaltSource {
  /**
   * The salt for a UTC day ("YYYY-MM-DD"), rotating first if the day changed.
   * Use the returned buffer immediately and never keep it: the next rotation
   * zeroes it in place.
   */
  forDay(day: string): Buffer;
}

function parse(buf: Buffer, length: number): { day: string; salt: Buffer } | undefined {
  if (length < SALT_FILE_BYTES) return undefined;
  const day = buf.toString("latin1", 0, DAY_BYTES);
  if (!DAY_RE.test(day) || utcDay(Date.parse(`${day}T00:00:00Z`) || 0) !== day) return undefined;
  const salt = Buffer.from(buf.subarray(DAY_BYTES, SALT_FILE_BYTES));
  // An all-zero salt means a zeroed or sparse file, not a real salt.
  if (salt.every((b) => b === 0)) return undefined;
  return { day, salt };
}

function fsyncDir(path: string): void {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write day + salt over the first 42 bytes of an open file, then fsync. */
function writeInPlace(fd: number, day: string, salt: Buffer): void {
  const record = Buffer.concat([Buffer.from(day, "latin1"), salt]);
  try {
    let written = 0;
    while (written < SALT_FILE_BYTES) {
      written += writeSync(fd, record, written, SALT_FILE_BYTES - written, written);
    }
    fsyncSync(fd);
  } finally {
    record.fill(0);
  }
}

/**
 * Open (or create) the salt file and make sure it holds today's salt. Throws if
 * the file cannot be created, read or written: the server should not start.
 */
export function openSaltFile(path: string, now: () => number = Date.now): SaltFile {
  return new SaltFile(path, now);
}

export class SaltFile implements SaltSource {
  private current: { day: string; salt: Buffer } | undefined;

  constructor(
    private readonly path: string,
    now: () => number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    const today = utcDay(now());
    const fd = this.openOrCreate();
    try {
      // Tighten permissions even if someone loosened them.
      fchmodSync(fd, MODE);
      const buf = Buffer.alloc(SALT_FILE_BYTES);
      const found = parse(buf, readSync(fd, buf, 0, SALT_FILE_BYTES, 0));
      buf.fill(0);
      if (found?.day === today) this.current = found;
      else {
        found?.salt.fill(0);
        this.current = { day: today, salt: randomBytes(SALT_BYTES) };
        writeInPlace(fd, today, this.current.salt);
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Open the existing file read-write, or create it exclusively (wx+, 0600) and fsync its directory. */
  private openOrCreate(): number {
    try {
      const fd = openSync(this.path, "wx+", MODE);
      // Make the new directory entry durable, not just the file contents.
      fsyncDir(this.path);
      return fd;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return openSync(this.path, "r+");
    }
  }

  forDay(day: string): Buffer {
    if (this.current?.day === day) return this.current.salt;
    // Whatever happens next, the old salt is gone from memory and never served again.
    this.current?.salt.fill(0);
    this.current = undefined;
    const salt = randomBytes(SALT_BYTES);
    const fd = this.openOrCreate();
    try {
      writeInPlace(fd, day, salt);
    } catch (err) {
      salt.fill(0);
      throw err;
    } finally {
      closeSync(fd);
    }
    this.current = { day, salt };
    return salt;
  }
}
