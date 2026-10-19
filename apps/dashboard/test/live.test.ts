import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveHub, startLive } from "@abigaail/server";
import { openStore, type EventRow } from "@abigaail/store";
import { closeLiveStreams, openRelay, openStreams, SSE_HEADERS, type RelayOptions } from "../lib/live";

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** An upstream we control: push chunks, see whether it was aborted. */
function fakeUpstream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const state = { aborted: false, push: (s: string) => ctrl.enqueue(new TextEncoder().encode(s)) };
  const upstream = async (signal: AbortSignal) => {
    signal.addEventListener("abort", () => (state.aborted = true));
    return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) }), {
      headers: { "content-type": "text/event-stream", authorization: "Bearer leaked", "x-upstream": "1" },
    });
  };
  return { state, upstream };
}

const opened: { close: () => void }[] = [];
async function relay(opts: Partial<RelayOptions> & Pick<RelayOptions, "upstream">) {
  const r = await openRelay({ sessionHash: "s1", stillValid: () => true, ...opts });
  if (r.ok) opened.push({ close: () => void r.stream.cancel().catch(() => {}) });
  return r;
}

afterEach(async () => {
  for (const o of opened.splice(0)) o.close();
  closeLiveStreams("s1");
  closeLiveStreams("s2");
  await until(() => openStreams() === 0);
});

describe("the relay", () => {
  it("passes events through and ends when the session goes away, aborting upstream", async () => {
    const { state, upstream } = fakeUpstream();
    let valid = true;
    const r = await relay({ upstream, stillValid: () => valid, limits: { recheckMs: 20 } });
    if (!r.ok) throw new Error("expected a stream");
    const reader = r.stream.getReader();
    state.push("event: events\ndata: {}\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: events");
    valid = false;
    expect((await reader.read()).done).toBe(true);
    expect(state.aborted).toBe(true);
    expect(openStreams()).toBe(0);
  });

  it("the browser going away aborts upstream", async () => {
    const { state, upstream } = fakeUpstream();
    const ac = new AbortController();
    const r = await relay({ upstream, signal: ac.signal });
    expect(r.ok).toBe(true);
    ac.abort();
    expect(state.aborted).toBe(true);
    expect(openStreams()).toBe(0);
  });

  it("sign-out closes that session's streams at once, and only those", async () => {
    const a = fakeUpstream();
    const b = fakeUpstream();
    const ra = await relay({ upstream: a.upstream, sessionHash: "s1" });
    const rb = await relay({ upstream: b.upstream, sessionHash: "s2" });
    if (!ra.ok || !rb.ok) throw new Error("expected streams");
    const readA = ra.stream.getReader();
    closeLiveStreams("s1");
    expect((await readA.read()).done).toBe(true);
    expect(a.state.aborted).toBe(true);
    expect(b.state.aborted).toBe(false);
    expect(openStreams("s2")).toBe(1);
  });

  it("caps streams per session and in total", async () => {
    const limits = { perSession: 2, total: 3 };
    expect((await relay({ upstream: fakeUpstream().upstream, limits })).ok).toBe(true);
    expect((await relay({ upstream: fakeUpstream().upstream, limits })).ok).toBe(true);
    expect(await relay({ upstream: fakeUpstream().upstream, limits })).toEqual({ ok: false, status: 429 });
    expect((await relay({ upstream: fakeUpstream().upstream, limits, sessionHash: "s2" })).ok).toBe(true);
    expect(await relay({ upstream: fakeUpstream().upstream, limits, sessionHash: "s2" })).toEqual({ ok: false, status: 429 });
  });

  it("maps upstream refusals: a refused token is 'off', a dead feed is unavailable", async () => {
    expect(await relay({ upstream: async () => new Response("no", { status: 401 }) })).toEqual({ ok: false, status: 503 });
    expect(await relay({ upstream: async () => { throw new TypeError("ECONNREFUSED"); } })).toEqual({ ok: false, status: 502 });
    expect(openStreams()).toBe(0);
  });

  it("sends only its own headers, never upstream's", () => {
    expect(Object.keys(SSE_HEADERS).sort()).toEqual(["cache-control", "content-type", "x-accel-buffering"]);
    expect(SSE_HEADERS["cache-control"]).toContain("no-transform");
  });
});

describe("relay backpressure against the real live feed", () => {
  it("a browser that never reads makes the server drop, while the relay reads almost nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abigaail-relay-"));
    const store = openStore(join(dir, "m.db"));
    const hub = new LiveHub();
    const token = "relay-test-token-0123456789abcdefghij";
    let live: http.Server | undefined;
    try {
      const { app } = store.createApp("app-r", "test");
      live = await startLive({ hub, store, token, port: 0, log: () => {}, limits: { eventsPerSec: 1e9, maxBufferedBytes: 16 * 1024, stuckMs: 60_000 } });
      const port = (live!.address() as AddressInfo).port;
      let readBytes = 0;
      const r = await relay({
        upstream: async (signal) => {
          const res = await fetch(`http://127.0.0.1:${port}/live?app=${app.id}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal });
          const count = new TransformStream<Uint8Array, Uint8Array>({ transform: (c, ctl) => { readBytes += c.byteLength; ctl.enqueue(c); } });
          return new Response(res.body!.pipeThrough(count), { status: res.status });
        },
      });
      expect(r.ok).toBe(true);
      await until(() => hub.size === 1);
      const row: EventRow = {
        event_id: "x", ts: 1, client_ts: 1, type: "request", route: "/x", method: "GET", status: 200, duration_ms: 5, host: null,
        name: null, value: null, sample_rate: null, visitor_hash: null, browser: null, bot_class: "human", attrs: null, parent_id: null,
      };
      const rows = Array.from({ length: 50 }, () => row);
      let published = 0;
      const end = Date.now() + 10_000;
      while (hub.dropped === 0 && Date.now() < end) {
        hub.publish(app.id, rows, "r");
        published += 50;
        await new Promise((res) => setImmediate(res));
      }
      expect(hub.dropped).toBeGreaterThan(0);
      // Nobody read the relay: it pulled at most a chunk or two, nowhere near what was sent.
      const sentBytes = published * 100;
      expect(readBytes).toBeLessThan(sentBytes / 10);
      expect(readBytes).toBeLessThan(256 * 1024);
    } finally {
      for (const o of opened.splice(0)) o.close();
      live?.closeAllConnections();
      await new Promise<void>((res) => (live ? live.close(() => res()) : res()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requireApiSession", () => {
  it("answers 401 without a redirect for no cookie or a dead session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abigaail-apisession-"));
    const cookie: { value: string | undefined } = { value: undefined };
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => (cookie.value === undefined ? undefined : { value: cookie.value }) }) }));
    vi.stubEnv("ABIGAAIL_DASHBOARD_SECRET", Buffer.alloc(32, 9).toString("base64"));
    vi.stubEnv("ABIGAAIL_AUTH_DB_PATH", join(dir, "auth.db"));
    try {
      const { requireApiSession } = await import("../lib/session");
      for (const v of [undefined, "not-a-real-session-token"]) {
        cookie.value = v;
        const res = await requireApiSession();
        expect(res).toBeInstanceOf(Response);
        expect((res as Response).status).toBe(401);
        expect((res as Response).headers.get("location")).toBeNull();
      }
    } finally {
      vi.doUnmock("next/headers");
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
