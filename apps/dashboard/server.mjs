// Dashboard server: Next.js behind a small node:http wrapper (`npm run dashboard`).
//
// The wrapper is what makes the sign-in throttle and the CSP trustworthy:
// - x-abigaail-peer is always overwritten with the socket address (or, with
//   ABIGAAIL_DASHBOARD_TRUST_PROXY=1, the address the one local proxy saw), so a
//   client cannot pick its own. Next only fills x-forwarded-for when it is missing.
// - every response gets a fresh CSP nonce and the security headers.
// It binds to 127.0.0.1 by default. The dashboard is never exposed publicly
// (see docs/HOSTING.md). It refuses to start without its secret or database.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretKey } from "@abigaail/auth";
import next from "next";

const dev = process.argv.includes("--dev");
const host = process.env.ABIGAAIL_DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.ABIGAAIL_DASHBOARD_PORT || 4319);
const trustProxy = process.env.ABIGAAIL_DASHBOARD_TRUST_PROXY === "1";
const dbPath = resolve(process.env.ABIGAAIL_DB_PATH || "./data/abigaail.db");

function fail(msg) {
  console.error(`[abigaail] dashboard not starting: ${msg}`);
  process.exit(1);
}
try {
  SecretKey.fromEnv();
} catch (err) {
  fail(err instanceof Error ? err.message : "ABIGAAIL_DASHBOARD_SECRET is invalid");
}
if (!existsSync(dbPath)) fail(`no database at ${dbPath} (start the server once with npm run dev:server, or set ABIGAAIL_DB_PATH)`);

// Route handlers refuse sign-in unless this wrapper set the peer header.
process.env.ABIGAAIL_DASHBOARD_SERVER = "1";

function peer(req) {
  if (trustProxy) {
    // The last entry is the one our own proxy appended; anything before it is client-supplied.
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress ?? "unknown";
}

function csp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes only (no inline scripts); SVG geometry uses attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const app = next({ dev, dir: dirname(fileURLToPath(import.meta.url)), hostname: host, port });
const handle = app.getRequestHandler();
await app.prepare();

const server = http.createServer((req, res) => {
  req.headers["x-abigaail-peer"] = peer(req);
  const nonce = randomBytes(16).toString("base64");
  const policy = csp(nonce);
  // Next reads the nonce from the request's CSP header and puts it on its scripts.
  req.headers["content-security-policy"] = policy;
  res.setHeader("content-security-policy", policy);
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-robots-tag", "noindex, nofollow");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy();
  });
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.listen(port, host, () => console.log(`[abigaail] dashboard on http://${host === "127.0.0.1" ? "localhost" : host}:${port}${dev ? " (dev)" : ""}`));

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
