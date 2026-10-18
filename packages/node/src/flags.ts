import type { RequestFlag } from "@abigaail/schema";

// Request flags are computed in memory from the raw URL and only the flag name
// leaves the app. Checks are bounded: at most MAX_SCAN characters, substring
// tests only (no regex that could backtrack), one guarded percent-decode.

export const MAX_SCAN = 2048;

const SCANNER_PATHS = ["/.env", "/.git", "wp-admin", "wp-login", ".php", "phpmyadmin", "/cgi-bin"];
const INJECTION = ["../", "..\\", "..%2f", "<script", "union select", "' or 1=1", "' or '1'='1", "/etc/passwd"];

function decodeOnce(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    // Malformed or truncated escape: check the raw text instead.
    return s;
  }
}

const anyOf = (hay: string, needles: readonly string[]) => needles.some((n) => hay.includes(n));

export function requestFlags(url: string, status: number): RequestFlag[] | undefined {
  const flags: RequestFlag[] = [];
  const raw = url.slice(0, MAX_SCAN).toLowerCase();
  const decoded = decodeOnce(raw);
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const decodedPath = decodeOnce(path);
  if (anyOf(path, SCANNER_PATHS) || anyOf(decodedPath, SCANNER_PATHS)) flags.push("scanner_path");
  if (anyOf(raw, INJECTION) || anyOf(decoded, INJECTION)) flags.push("injection_like");
  if (status === 401) flags.push("auth_failure");
  if (status === 429) flags.push("rate_limited");
  return flags.length ? flags : undefined;
}
