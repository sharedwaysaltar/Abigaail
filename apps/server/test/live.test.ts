import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, LIVE, LiveHub, startLive, type LiveLimits } from "@abigaail/server";
import { LIVE_FIELDS, type EventRow } from "@abigaail/store";
import { batch, post, rawRequest, requestEvent, startServer, T0, uuid, type TestServer } from "./helpers.js";

const TOKEN = "live-token-for-tests-0123456789abcdef";
const IP = "203.0.113.77";
const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36 livetest-7q2m";

let s: TestServer;
let hub: LiveHub;
let live: http.Server | undefined;
let livePort: number;
let appA: string;
let keyA: string;
let appB: string;
let keyB: string;

async function setup(limits: Partial<LiveLimits> = {}, extra: { peerOf?: () => string } = {}) {
  hub = new LiveHub();
  s = await startServer({ live: hub });
  ({ key: keyA, app: { id: appA } } = s.store.createApp("app-a", "test"));
  ({ key: keyB, app: { id: appB } } = s.store.createApp("app-b", "test"));
  live = await startLive({ hub, store: s.store, token: TOKEN, port: 0, log: () => {}, limits, ...extra });
  livePort = (live!.address() as AddressInfo).port;
}

afterEach(async () => {
  if (live) {
    live.closeAllConnections();
    await new Promise<void>((r) => live!.close(() => r()));
    live = undefined;
  }
  await s?.close();
});

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

interface Stream {
  status: number;
  text: () => string;
  events: () => Record<string, unknown>[];
  ended: () => boolean;
  close: () => void;
}

/** Open a live stream with node:http, collecting everything it sends. */
function openLive(opts: { app?: string; token?: string | null; host?: string; method?: string } = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${livePort}` };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
    let text = "";
    let ended = false;
    const req = http.request({ host: "127.0.0.1", port: livePort, path: `/live?app=${opts.app ?? appA}`, method: opts.method ?? "GET", headers }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d: string) => (text += d));
      res.on("end", () => (ended = true));
      res.on("close", () => (ended = true));
      resolve({
        status: res.statusCode ?? 0,
        text: () => text,
        events: () =>
          [...text.matchAll(/^event: events\ndata: (.*)$/gm)].flatMap((m) => (JSON.parse(m[1]!) as { events: Record<string, unknown>[] }).events),
        ended: () => ended,
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function row(i: number, type = "request"): EventRow {
  return {
    event_id: uuid(), ts: T0 + i, client_ts: T0, type, route: "/x", method: "GET", status: 200, duration_ms: 5, host: null,
    name: null, value: null, sample_rate: null, visitor_hash: "ab".repeat(16), browser: "chrome", bot_class: "human", attrs: null, parent_id: null,
  };
}

describe("what the stream carries", () => {
  beforeEach(() => setup());

  it("only allowlisted fields: no IP, user agent, visitor hash, event id, referrer or frames", async () => {
    const st = await openLive();
    expect(st.status).toBe(200);
    await until(() => hub.size === 1);
    const req = requestEvent({ transient: { ip: IP, ua: UA }, referrer_domain: "referrer-marker.example", flags: ["scanner_path"] });
    const out = { type: "outbound", event_id: uuid(), client_ts: T0, host: "api.example.com", method: "GET", status: 502, duration_ms: 40, outcome: "ok", parent_id: req.event_id };
    const err = {
      type: "error", event_id: uuid(), client_ts: T0, error_type: "TypeError", route: "/user/[id]", handled: false,
      frames: [{ file: "src/frame-marker.ts", line: 3 }], parent_id: req.event_id,
    };
    const metric = { type: "metric", event_id: uuid(), client_ts: T0, name: "memory_rss_mb", value: 123 };
    const boot = { type: "lifecycle", event_id: uuid(), client_ts: T0, kind: "boot", region: "LON1" };
    const sent = [req, out, err, metric, boot];
    expect((await post(s, batch(sent), { key: keyA })).status).toBe(202);
    await until(() => st.events().length === 5);

    const text = st.text();
    const stored = s.raw<{ visitor_hash: string | null }>("SELECT visitor_hash FROM events WHERE visitor_hash IS NOT NULL");
    expect(stored.length).toBe(1);
    const forbidden = [IP, "livetest-7q2m", stored[0]!.visitor_hash!, "referrer-marker", "frame-marker", "LON1", "chrome", "abc123x"];
    for (const e of sent) forbidden.push((e as { event_id: string }).event_id);
    for (const f of forbidden) expect(text).not.toContain(f);
    for (const e of st.events()) {
      const allowed = LIVE_FIELDS[e.type as keyof typeof LIVE_FIELDS];
      expect(allowed, String(e.type)).toBeDefined();
      for (const k of Object.keys(e)) expect(allowed).toContain(k);
    }
    expect(st.events().map((e) => e.type)).toEqual(["request", "outbound", "error", "metric", "lifecycle"]);
    expect(st.events()[0]).toMatchObject({ route: "/user/[id]", status: 200, flags: ["scanner_path"], release: "abc123" });
    st.close();
  });

  it("a retried batch reaches the stream once", async () => {
    const st = await openLive();
    await until(() => hub.size === 1);
    const b = batch([requestEvent(), requestEvent()]);
    await post(s, b, { key: keyA });
    await post(s, b, { key: keyA });
    await post(s, batch([requestEvent()]), { key: keyA });
    await until(() => st.events().length >= 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(st.events()).toHaveLength(3);
    st.close();
  });

  it("is scoped by app: a subscriber of app A never sees app B's events", async () => {
    const a = await openLive({ app: appA });
    const b = await openLive({ app: appB });
    await until(() => hub.size === 2);
    await post(s, batch([requestEvent({ route: "/only-b" })]), { key: keyB });
    await post(s, batch([requestEvent({ route: "/only-a" })]), { key: keyA });
    await until(() => a.events().length === 1 && b.events().length === 1);
    expect(a.text()).not.toContain("/only-b");
    expect(b.text()).not.toContain("/only-a");
    a.close();
    b.close();
  });

  it("refuses an unknown or malformed app id", async () => {
    expect((await openLive({ app: "00000000-0000-4000-8000-ffffffffffff" })).status).toBe(404);
    expect((await openLive({ app: "not-a-uuid" })).status).toBe(400);
    expect((await openLive({ app: "" })).status).toBe(400);
  });

  it("costs nothing when nobody is watching: rows are not even read", () => {
    const poisoned = { get type(): string { throw new Error("read"); } } as unknown as EventRow;
    expect(() => hub.publish(appA, [poisoned], "r")).not.toThrow();
  });
});

describe("the listener is loopback-only and needs the token", () => {
  it("the public ingest port never serves /live", async () => {
    await setup();
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }] as Record<string, string>[]) {
      const res = await fetch(`${s.url}/live?app=${appA}`, { headers });
      expect(res.status).toBe(404);
    }
  });

  it("binds 127.0.0.1 whatever the environment says, and config has no live host", async () => {
    process.env.ABIGAAIL_LIVE_HOST = "0.0.0.0";
    try {
      await setup();
      expect((live!.address() as AddressInfo).address).toBe("127.0.0.1");
      expect(LIVE.host).toBe("127.0.0.1");
      const cfg = loadConfig({ ABIGAAIL_LIVE_HOST: "0.0.0.0", ABIGAAIL_LIVE_PORT: "4999" });
      expect(cfg.livePort).toBe(4999);
      expect(Object.keys(cfg).filter((k) => /live/i.test(k)).sort()).toEqual(["livePort", "liveToken"]);
    } finally {
      delete process.env.ABIGAAIL_LIVE_HOST;
    }
  });

  it("a peer that is not this machine gets no answer at all", async () => {
    await setup({}, { peerOf: () => "192.168.1.20" });
    const r = await rawRequest(livePort, `GET /live?app=${appA} HTTP/1.1\r\nHost: 127.0.0.1:${livePort}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    expect(r.closedByServer).toBe(true);
    expect(r.response).toBe("");
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    await setup();
    expect((await openLive({ host: "evil.example" })).status).toBe(403);
    expect((await openLive({ host: `localhost:${livePort}` })).status).toBe(200);
  });

  it("needs the bearer token; a flood of bad tokens is rate-limited but never locks out the right one", async () => {
    await setup({ badTokenRate: { perSec: 0.001, burst: 3 } });
    expect((await openLive({ token: null })).status).toBe(401);
    expect((await openLive({ token: "wrong" })).status).toBe(401);
    expect((await openLive({ token: TOKEN.slice(0, -1) + "X" })).status).toBe(401);
    expect((await openLive({ token: "wrong" })).status).toBe(429);
    const ok = await openLive();
    expect(ok.status).toBe(200);
    ok.close();
  });

  it("GET only, with no body", async () => {
    await setup();
    expect((await openLive({ method: "POST" })).status).toBe(405);
    const r = await rawRequest(livePort, `GET /live?app=${appA} HTTP/1.1\r\nHost: 127.0.0.1:${livePort}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 3\r\n\r\nabc`);
    expect(r.response).toMatch(/^HTTP\/1\.1 400/);
  });

  it("does not start without a long enough token, and never logs it", async () => {
    hub = new LiveHub();
    s = await startServer({ live: hub });
    for (const token of ["", "short-token"]) {
      const lines: string[] = [];
      expect(await startLive({ hub, store: s.store, token, port: 0, log: (m) => lines.push(m) })).toBeUndefined();
      expect(lines).toHaveLength(1);
      if (token) expect(lines[0]).not.toContain(token);
    }
  });
});

describe("a slow or disconnected browser cannot grow server memory", () => {
  it("drops instead of queueing for a client that never reads, then disconnects it", async () => {
    const maxBufferedBytes = 16 * 1024;
    await setup({ eventsPerSec: 1e9, maxBufferedBytes, stuckMs: 150, pingMs: 25 });
    const sock = net.connect(livePort, "127.0.0.1");
    sock.on("error", () => {});
    sock.write(`GET /live?app=${appA} HTTP/1.1\r\nHost: 127.0.0.1:${livePort}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    sock.pause();
    await until(() => hub.size === 1);
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    let peak = 0;
    // Publish across event-loop turns, as a busy app would, until the kernel's
    // socket buffers are full and the subscriber has been behind for stuckMs.
    const end = Date.now() + 10_000;
    while (hub.size > 0 && Date.now() < end) {
      hub.publish(appA, rows, "r");
      peak = Math.max(peak, 0, ...hub.buffered());
      await new Promise((r) => setImmediate(r));
    }
    expect(hub.size).toBe(0);
    expect(hub.dropped).toBeGreaterThan(0);
    // At most the cap plus one message (50 small events).
    expect(peak).toBeLessThanOrEqual(maxBufferedBytes + 16 * 1024);
    sock.destroy();
  });

  it("caps open streams, and a closed one frees its slot", async () => {
    await setup({ maxSubscribers: 2 });
    const a = await openLive();
    const b = await openLive();
    await until(() => hub.size === 2);
    expect((await openLive()).status).toBe(503);
    a.close();
    await until(() => hub.size === 1);
    const c = await openLive();
    expect(c.status).toBe(200);
    b.close();
    c.close();
    await until(() => hub.size === 0);
  });

  it("over the rate cap, events are dropped and reported as a gap", async () => {
    await setup({ eventsPerSec: 5, pingMs: 30 });
    const st = await openLive();
    await until(() => hub.size === 1);
    hub.publish(appA, Array.from({ length: 40 }, (_, i) => row(i)), "r");
    await until(() => /event: gap\ndata: \{"dropped":(\d+)\}/.test(st.text()));
    expect(st.events().length).toBeLessThanOrEqual(10);
    const dropped = Number(/"dropped":(\d+)/.exec(st.text())![1]);
    expect(st.events().length + dropped).toBe(40);
    st.close();
  });

  it("every stream ends after its lifetime", async () => {
    await setup({ maxStreamMs: 100 });
    const st = await openLive();
    await until(() => st.ended());
    expect(st.text()).toContain("retry: 5000");
    await until(() => hub.size === 0);
  });
});

describe("live never affects ingest", () => {
  it("a publish that throws still answers 202, stores the batch, and stays inside live", async () => {
    const lines: string[] = [];
    s = await startServer({ live: { publish: () => { throw new TypeError("boom"); } }, log: (m) => lines.push(m) });
    const { key } = s.store.createApp("app-x", "test");
    // One keep-alive connection for all three batches: a failure must not tear it down.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new Set<unknown>();
    const send = (body: unknown) =>
      new Promise<number>((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
          { host: "127.0.0.1", port: s.port, path: "/ingest", method: "POST", agent,
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-abigaail-key": key } },
          (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
        );
        req.on("socket", (sock) => sockets.add(sock));
        req.on("error", reject);
        req.end(data);
      });
    for (let i = 0; i < 3; i++) expect(await send(batch([requestEvent(), requestEvent()]))).toBe(202);
    agent.destroy();
    expect(sockets.size).toBe(1);
    expect(s.raw<{ n: number }>("SELECT count(*) AS n FROM events")[0]!.n).toBe(6);
    // Logged once per failure streak, by name, never as an ingest internal error.
    expect(lines).toEqual(["live: could not publish (TypeError)"]);
  });
});
