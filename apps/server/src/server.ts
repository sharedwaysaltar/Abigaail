// Ingest HTTP server. Cheap checks run before the body is read; anything
// rejected before that point closes the connection so the body never is.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { LIMITS } from "@abigaail/schema";
import { validateBatch } from "@abigaail/schema/validate";
import type { App, Store } from "@abigaail/store";
import { classifyUserAgent, eventTime, utcDay, visitorHash } from "./derive.js";
import { TokenBucket } from "./ratelimit.js";
import type { SaltSource } from "./salt.js";

export interface ServerOptions {
  store: Store;
  /** Daily visitor-hash salt (see salt.ts). Never stored in the database. */
  salt: SaltSource;
  now?: () => number;
  /** Logs fixed messages only: never bodies, keys, IPs or user agents. */
  log?: (msg: string) => void;
  maxBodyBytes?: number;
  /** Per-app batch rate limit. Default 20/s, burst 40. */
  appRate?: { perSec: number; burst: number };
  /** Global limit on requests with a missing or unknown key. Default 10/s, burst 20. */
  badKeyRate?: { perSec: number; burst: number };
  timeouts?: {
    headersMs?: number;
    requestMs?: number;
    keepAliveMs?: number;
    /** How often Node checks the header/request timeouts. */
    checkIntervalMs?: number;
  };
  maxHeaderSize?: number;
}

const JSON_TYPE = "application/json";

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": `${JSON_TYPE}; charset=utf-8`,
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/**
 * Respond and close without reading the request body. Node would otherwise
 * drain the remaining body to keep the connection alive.
 */
function sendAndClose(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  req.pause();
  res.once("finish", () => req.socket.destroy());
  send(res, status, body, { ...headers, connection: "close" });
}

/** The error's class name only, never its message. Anything not identifier-like is reported as "Error". */
function errorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : "Error";
}

type BodyResult = { ok: true; body: Buffer } | { ok: false; reason: "too_large" | "aborted" };

/** Read the body with a hard byte cap; stops reading as soon as the cap is passed. */
function readBody(req: IncomingMessage, max: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: BodyResult) => {
      if (done) return;
      done = true;
      req.off("data", onData);
      resolve(r);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.pause();
        finish({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => finish({ ok: true, body: Buffer.concat(chunks, size) }));
    req.once("error", () => finish({ ok: false, reason: "aborted" }));
    req.once("close", () => finish({ ok: false, reason: "aborted" }));
  });
}

export function createServer(opts: ServerOptions): http.Server {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => console.error(`[abigaail] ${msg}`));
  const maxBody = opts.maxBodyBytes ?? LIMITS.maxBatchBytes;
  const appRate = opts.appRate ?? { perSec: 20, burst: 40 };
  const badKeyRate = opts.badKeyRate ?? { perSec: 10, burst: 20 };
  const t = opts.timeouts ?? {};

  const badKeys = new TokenBucket(badKeyRate.perSec, badKeyRate.burst, now);
  // One bucket per known app: bounded by the number of apps, not by callers.
  const appBuckets = new Map<string, TokenBucket>();
  let saltFailing = false;

  /**
   * Today's salt, or undefined if it cannot be rotated. Never falls back to an
   * older salt: events then get a null visitor hash until rotation succeeds.
   */
  const saltFor = (day: string): Buffer | undefined => {
    try {
      const value = opts.salt.forDay(day);
      if (saltFailing) log("salt rotation recovered; visitor hashes resumed");
      saltFailing = false;
      return value;
    } catch (err) {
      // Logged once per failure streak, not once per request.
      if (!saltFailing) log(`salt rotation failed (${errorClass(err)}); visitor hashes are null until it succeeds`);
      saltFailing = true;
      return undefined;
    }
  };

  async function ingest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== JSON_TYPE) return sendAndClose(req, res, 415, { error: "unsupported_media_type" });

    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > maxBody) {
      return sendAndClose(req, res, 413, { error: "payload_too_large", max_bytes: maxBody });
    }

    const key = req.headers["x-abigaail-key"];
    const app: App | undefined = typeof key === "string" && key ? store.appByKey(key) : undefined;
    if (!app) {
      // Key-guessing floods are refused cheaply once the global budget is spent.
      if (!badKeys.take()) return sendAndClose(req, res, 429, { error: "rate_limited" }, { "retry-after": "1" });
      return sendAndClose(req, res, 401, { error: "invalid_key" });
    }
    if (app.disabled_at !== null) return sendAndClose(req, res, 403, { error: "app_disabled" });

    let bucket = appBuckets.get(app.id);
    if (!bucket) appBuckets.set(app.id, (bucket = new TokenBucket(appRate.perSec, appRate.burst, now)));
    if (!bucket.take()) {
      return sendAndClose(req, res, 429, { error: "rate_limited" }, { "retry-after": String(bucket.retryAfterSec()) });
    }

    const body = await readBody(req, maxBody);
    if (!body.ok) {
      if (body.reason === "too_large") sendAndClose(req, res, 413, { error: "payload_too_large", max_bytes: maxBody });
      // Aborted or timed out: Node has already answered or closed the socket.
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.body.toString("utf8"));
    } catch {
      return send(res, 400, { error: "invalid_json" });
    }

    const result = validateBatch(parsed);
    // One invalid event rejects the whole batch; nothing is stored.
    if (!result.ok) return send(res, 400, { error: "invalid_batch", issues: result.issues });
    const batch = result.batch;

    // The salt day comes from receive time (UTC), never from event time, so a
    // retried batch never needs an already-rotated salt. The buffer is used
    // within this synchronous block only: rotation zeroes it.
    const receivedAt = now();
    const daySalt = saltFor(utcDay(receivedAt));

    const events = batch.events.map((event) => {
      const ts = eventTime(receivedAt, batch.sent_at, event.client_ts);
      if (event.type !== "request") return { event, derived: { ts } };
      // The visitor IP comes only from the event's transient field. The socket
      // address belongs to the monitored app's server and is never used.
      const ip = event.transient?.ip;
      const ua = event.transient?.ua;
      return {
        event,
        derived: {
          ts,
          visitor_hash: ip && daySalt ? visitorHash(daySalt, app.id, ip, ua) : null,
          ...classifyUserAgent(ua),
        },
      };
    });

    const { inserted, duplicates } = store.insertBatch(app.id, {
      receivedAt,
      release: batch.release,
      environment: batch.environment,
      events,
    });
    send(res, 202, { accepted: inserted, duplicates });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendAndClose(req, res, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      return send(res, 200, { ok: true });
    }
    if (path !== "/ingest") return sendAndClose(req, res, 404, { error: "not_found" });
    if (req.method !== "POST") return sendAndClose(req, res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return ingest(req, res);
  }

  const server = http.createServer(
    {
      maxHeaderSize: opts.maxHeaderSize ?? 16 * 1024,
      headersTimeout: t.headersMs ?? 10_000,
      requestTimeout: t.requestMs ?? 15_000,
      // Node only checks the two timeouts above this often (default 30s).
      connectionsCheckingInterval: t.checkIntervalMs ?? 2_000,
    },
    (req, res) => {
      handle(req, res).catch((err: unknown) => {
        log(`ingest: internal error (${errorClass(err)})`);
        if (!res.headersSent) sendAndClose(req, res, 500, { error: "internal" });
        else res.destroy();
      });
    },
  );
  server.keepAliveTimeout = t.keepAliveMs ?? 5_000;

  // Rotate the salt at each UTC midnight even if no request arrives, so
  // yesterday's salt never outlives its day. unref'd: never keeps the process alive.
  let rotation: ReturnType<typeof setTimeout> | undefined;
  const scheduleRotation = () => {
    const t0 = now();
    // Epoch time has no leap seconds, so UTC days are exactly 86,400,000 ms.
    const nextMidnight = (Math.floor(t0 / 86_400_000) + 1) * 86_400_000;
    rotation = setTimeout(() => {
      saltFor(utcDay(now()));
      scheduleRotation();
    }, Math.max(1, nextMidnight - t0));
    rotation.unref();
  };
  scheduleRotation();
  server.on("close", () => clearTimeout(rotation));
  return server;
}
