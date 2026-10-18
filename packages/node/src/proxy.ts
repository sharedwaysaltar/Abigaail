import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

const MAPPED = /^::ffff:/i;

/** Loopback or private-range address: the usual sign of a reverse proxy in front of the app. */
export function isLocalAddress(ip: string): boolean {
  const a = ip.replace(MAPPED, "").toLowerCase();
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number) as [number, number];
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
  }
  return a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80:");
}

/**
 * Client IP for the transient field. With trustProxy = n, the nth entry from
 * the right of X-Forwarded-For is used (each trusted proxy appends one). With
 * fewer entries than hops the header is not trusted and nothing is returned.
 */
export function clientIp(req: IncomingMessage, trustProxy: number): string | undefined {
  let ip: string | undefined;
  if (trustProxy > 0) {
    const header = req.headers["x-forwarded-for"];
    const value = Array.isArray(header) ? header.join(",") : header;
    if (value && value.length <= 4096) {
      const hops = value.split(",");
      ip = hops[hops.length - trustProxy]?.trim();
    }
  } else {
    ip = req.socket?.remoteAddress;
  }
  return ip && isIP(ip) ? ip : undefined;
}
