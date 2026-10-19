// Live feed (DECISIONS #69, #71, #72): Server-Sent Events on a loopback-only
// listener, never on the ingest port. The dashboard relays it after its own
// session check; nothing else can reach it.
//
// Memory stays bounded whatever a client does: subscribers are capped, there is
// no per-subscriber queue (a subscriber that is behind has events dropped and
// counted, then gets one "gap" message), events per second are capped, a
// subscriber stuck behind is disconnected, and every stream ends after a while.

import { createHash, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toLiveEvent, type App, type EventRow, type LiveEvent } from "@abigaail/store";
import { TokenBucket } from "./ratelimit.js";

/** Every live tunable. The host is not configurable: the feed stays on loopback. */
export const LIVE = {
  host: "127.0.0.1",
  defaultPort: 4320,
  /** Open streams in total; one more gets 503. */
  maxSubscribers: 16,
  /** A subscriber with more than this waiting in its socket buffer is behind. */
  maxBufferedBytes: 64 * 1024,
  /** Events per second per subscriber (burst twice that); the rest are dropped and counted. */
  eventsPerSec: 200,
  /** Events per SSE message, so one 500-event batch is several small writes. */
  maxPerMessage: 50,
  pingMs: 15_000,
  /** A subscriber behind for this long is disconnected. */
  stuckMs: 30_000,
  /** Streams end after this; the browser reconnects (and its session is checked again). */
  maxStreamMs: 15 * 60_000,
  /** Reconnect delay the browser is told to use. */
  retryMs: 5_000,
  /** Failed token attempts only: a valid token never touches this bucket. */
  badTokenRate: { perSec: 2, burst: 10 },
  minTokenLength: 32,
  maxHeaderSize: 8 * 1024,
  headersTimeoutMs: 10_000,
};

export type LiveLimits = typeof LIVE;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 127.0.0.0/8, ::1, and IPv4-mapped 127.x. Anything else is not this machine. */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** One open stream. Writes only while the socket keeps up; otherwise counts what it drops. */
export class Subscriber {
  dropped = 0;
  private behindSince: number | undefined;
  private readonly bucket: TokenBucket;
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    readonly appId: string,
    private readonly res: ServerResponse,
    private readonly limits: LiveLimits,
    private readonly now: () => number,
    private readonly hub: LiveHub,
  ) {
    this.bucket = new TokenBucket(limits.eventsPerSec, limits.eventsPerSec * 2, now);
    const ping = setInterval(() => this.tick(), limits.pingMs);
    const life = setTimeout(() => this.end(), limits.maxStreamMs);
    ping.unref();
    life.unref();
    this.timers.push(ping, life);
    res.on("drain", () => this.caughtUp());
    res.once("close", () => this.close());
  }

  /** Bytes waiting in this stream's socket buffer: what a slow client can cost the server. */
  get buffered(): number {
    return this.res.writableLength;
  }

  private behind(): boolean {
    return this.res.writableNeedDrain || this.res.writableLength > this.limits.maxBufferedBytes;
  }

  send(events: readonly LiveEvent[]): void {
    if (this.res.destroyed) return;
    let n = 0;
    while (n < events.length && this.bucket.take()) n++;
    this.drop(events.length - n);
    for (let i = 0; i < n; i += this.limits.maxPerMessage) {
      if (this.behind()) {
        this.drop(n - i);
        this.behindSince ??= this.now();
        if (this.now() - this.behindSince > this.limits.stuckMs) this.res.destroy();
        return;
      }
      this.res.write(`event: events\ndata: ${JSON.stringify({ events: events.slice(i, Math.min(n, i + this.limits.maxPerMessage)) })}\n\n`);
    }
  }

  private drop(k: number): void {
    if (k > 0) {
      this.dropped += k;
      this.hub.dropped += k;
    }
  }

  private caughtUp(): void {
    this.behindSince = undefined;
    if (this.dropped > 0 && !this.res.destroyed) {
      this.res.write(`event: gap\ndata: ${JSON.stringify({ dropped: this.dropped })}\n\n`);
      this.dropped = 0;
    }
  }

  private tick(): void {
    if (this.behind()) {
      this.behindSince ??= this.now();
      if (this.now() - this.behindSince > this.limits.stuckMs) this.res.destroy();
      return;
    }
    // A gap noticed by the rate cap (socket never full) is reported here.
    if (this.dropped > 0) this.caughtUp();
    else this.res.write(": ping\n\n");
  }

  end(): void {
    if (!this.res.destroyed) this.res.end();
  }

  private close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.hub.remove(this);
  }
}

/** Subscribers per app. publish() is called from ingest and must stay cheap and never throw into it. */
export class LiveHub {
  /** Events dropped for any subscriber since start (behind or over the rate cap). */
  dropped = 0;
  private readonly byApp = new Map<string, Set<Subscriber>>();
  private count = 0;

  get size(): number {
    return this.count;
  }

  /** Buffered bytes per open stream, for tests and diagnostics. */
  buffered(): number[] {
    return [...this.byApp.values()].flatMap((set) => [...set].map((s) => s.buffered));
  }

  add(sub: Subscriber): void {
    let set = this.byApp.get(sub.appId);
    if (!set) this.byApp.set(sub.appId, (set = new Set()));
    set.add(sub);
    this.count++;
  }

  remove(sub: Subscriber): void {
    const set = this.byApp.get(sub.appId);
    if (!set?.delete(sub)) return;
    this.count--;
    if (!set.size) this.byApp.delete(sub.appId);
  }

  /** Send an app's newly stored rows to that app's subscribers only. No subscribers: returns at once. */
  publish(appId: string, rows: readonly EventRow[], release: string): void {
    const set = this.byApp.get(appId);
    if (!set?.size || !rows.length) return;
    const events: LiveEvent[] = [];
    for (const row of rows) {
      const e = toLiveEvent(row, release);
      if (e) events.push(e);
    }
    for (const sub of set) sub.send(events);
  }

  /** End every stream (shutdown). */
  endAll(): void {
    for (const set of this.byApp.values()) for (const sub of set) sub.end();
  }

  /** @internal */
  subscribe(appId: string, res: ServerResponse, limits: LiveLimits, now: () => number): void {
    this.add(new Subscriber(appId, res, limits, now, this));
  }
}

export interface LiveServerOptions {
  hub: LiveHub;
  /** App lookup by id, to refuse unknown apps. */
  store: { appById(id: string): App | undefined };
  token: string;
  now?: () => number;
  /** Fixed messages only: never the token. */
  log?: (msg: string) => void;
  limits?: Partial<LiveLimits>;
  /** The request's peer address. Default: the socket address. Tests inject one. */
  peerOf?: (req: IncomingMessage) => string | undefined;
}

function sendAndClose(req: IncomingMessage, res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  const body = JSON.stringify({ error });
  req.pause();
  res.once("finish", () => req.socket.destroy());
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    connection: "close",
    ...headers,
  });
  res.end(body);
}

export function createLiveServer(opts: LiveServerOptions): http.Server {
  const limits: LiveLimits = { ...LIVE, ...opts.limits };
  const now = opts.now ?? Date.now;
  const want = digest(opts.token);
  const badTokens = new TokenBucket(limits.badTokenRate.perSec, limits.badTokenRate.burst, now);
  const peerOf = opts.peerOf ?? ((req: IncomingMessage) => req.socket.remoteAddress);

  const tokenOk = (header: string | undefined): boolean => {
    const m = /^Bearer (\S{1,512})$/.exec(header ?? "");
    return !!m && timingSafeEqual(digest(m[1]!), want);
  };

  const server = http.createServer({ maxHeaderSize: limits.maxHeaderSize, headersTimeout: limits.headersTimeoutMs }, (req, res) => {
    // Not this machine: no answer at all.
    if (!isLoopback(peerOf(req))) {
      req.socket.destroy();
      return;
    }
    // DNS rebinding: a page that resolves its own name to 127.0.0.1 still sends its own Host.
    const port = (server.address() as AddressInfo | null)?.port;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendAndClose(req, res, 403, "forbidden_host");
    const [path, query = ""] = (req.url ?? "/").split("?", 2);
    if (path !== "/live") return sendAndClose(req, res, 404, "not_found");
    if (req.method !== "GET") return sendAndClose(req, res, 405, "method_not_allowed", { allow: "GET" });
    if ((req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") || req.headers["transfer-encoding"] !== undefined) {
      return sendAndClose(req, res, 400, "unexpected_body");
    }
    // The token is checked first; only a failed attempt costs from the bucket.
    if (!tokenOk(req.headers.authorization)) {
      if (!badTokens.take()) return sendAndClose(req, res, 429, "rate_limited", { "retry-after": "1" });
      return sendAndClose(req, res, 401, "invalid_token");
    }
    const appId = new URLSearchParams(query).get("app") ?? "";
    if (!UUID_RE.test(appId)) return sendAndClose(req, res, 400, "invalid_app");
    if (!opts.store.appById(appId)) return sendAndClose(req, res, 404, "unknown_app");
    if (opts.hub.size >= limits.maxSubscribers) return sendAndClose(req, res, 503, "too_many_streams", { "retry-after": "30" });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.write(`retry: ${limits.retryMs}\n\n`);
    opts.hub.subscribe(appId, res, limits, now);
  });
  server.on("close", () => opts.hub.endAll());
  return server;
}

/**
 * Start the live listener on 127.0.0.1 (never another host). Returns undefined,
 * after one log line, when the token is missing or too short: ingest and agents
 * run as usual, only the Live view is off.
 */
export async function startLive(opts: LiveServerOptions & { port: number }): Promise<http.Server | undefined> {
  const log = opts.log ?? ((msg: string) => console.error(`[abigaail] ${msg}`));
  const min = opts.limits?.minTokenLength ?? LIVE.minTokenLength;
  if (!opts.token || opts.token.length < min) {
    log(`live view off (ABIGAAIL_LIVE_TOKEN not set or shorter than ${min} characters)`);
    return undefined;
  }
  const server = createLiveServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, LIVE.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
