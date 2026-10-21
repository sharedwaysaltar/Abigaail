import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultLinkOutbound, init, type AbigaailNode, type NodeOptions } from "@abigaail/node";
import type { Transport } from "@abigaail/core";
import type { AbigaailEvent, Batch, RequestEvent } from "@abigaail/schema";
import { validateBatch } from "@abigaail/schema/validate";

let adapter: AbigaailNode | undefined;
const servers: http.Server[] = [];

afterEach(async () => {
  await adapter?.shutdown(100);
  adapter = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function start(opts: NodeOptions = {}) {
  const batches: Batch[] = [];
  const warnings: unknown[] = [];
  const transport: Transport = async (b) => {
    batches.push(structuredClone(b));
    return "ok";
  };
  adapter = init({
    endpoint: "http://127.0.0.1:9/ingest",
    ingestKey: "k",
    release: "r1",
    environment: "test",
    flushIntervalMs: 0,
    metricsIntervalMs: 0,
    heartbeatIntervalMs: 0,
    transport,
    onInternalError: (e) => warnings.push(e),
    env: {},
    // Pinned so defaults do not depend on the Node running the tests.
    nodeVersion: "24.0.0",
    ...opts,
  });
  const events = async (type?: AbigaailEvent["type"]) => {
    await adapter!.flush();
    for (const b of batches) expect(validateBatch(b)).toMatchObject({ ok: true });
    const all = batches.flatMap((b) => b.events);
    return type ? all.filter((e) => e.type === type) : all;
  };
  return { batches, warnings, events, adapter };
}

async function server(handler: http.RequestListener = (_q, s) => s.end("ok")): Promise<string> {
  const s = http.createServer({ maxHeaderSize: 256 * 1024 }, handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, r));
  return `http://localhost:${(s.address() as AddressInfo).port}`;
}

/** Raw request, so the URL reaches the server exactly as written. */
function raw(base: string, path: string, opts: http.RequestOptions & { body?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path, ...opts }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const requests = async (events: (t: "request") => Promise<AbigaailEvent[]>) =>
  (await events("request")) as RequestEvent[];

describe("inbound requests", () => {
  it("captures method, normalised route, status, duration and bytes, and nothing personal", async () => {
    const { events } = start({ routes: ["/user/[id]"] });
    const base = await server((_q, s) => {
      s.setHeader("content-length", "2");
      s.end("ok");
    });
    await raw(base, "/user/42?email=canary%40x.y&token=CANARYTOKEN", {
      method: "POST",
      headers: {
        cookie: "sid=CANARYCOOKIE",
        authorization: "Bearer CANARYAUTH",
        referer: "https://ref.example/p?q=CANARYREF",
        "user-agent": "Mozilla/5.0 Firefox/130.0",
        "content-length": "10",
      },
      body: "CANARYBODY",
    });
    const [e] = await requests(events);
    expect(e).toMatchObject({
      method: "POST",
      route: "/user/[id]",
      status: 200,
      req_bytes: 10,
      res_bytes: 2,
      referrer_domain: "ref.example",
    });
    expect(e!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(e!.transient?.ua).toBe("Mozilla/5.0 Firefox/130.0");
    expect(JSON.stringify(await events())).not.toMatch(/canary/i);
  });

  it("a 404 on no known pattern is 'unmatched' and flagged; the query value never leaves", async () => {
    const { events } = start({ routes: ["/user/[id]"] });
    const base = await server((_q, s) => {
      s.statusCode = 404;
      s.end();
    });
    await raw(base, "/.env?x=secret");
    await raw(base, "/user/999");
    const [probe, user] = await requests(events);
    expect(probe).toMatchObject({ route: "unmatched", status: 404, flags: ["scanner_path"] });
    expect(user).toMatchObject({ route: "/user/[id]", status: 404 });
    expect(user!.flags).toBeUndefined();
    expect(JSON.stringify(await events())).not.toContain("secret");
  });

  it("checks only a bounded prefix of a 100 KB URL, quickly", async () => {
    const { events } = start();
    const base = await server();
    const long = "/a?" + "x".repeat(100_000) + "<script>";
    const t0 = performance.now();
    expect(await raw(base, long)).toBe(200);
    const [e] = await requests(events);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(e!.flags).toBeUndefined(); // the payload sits beyond the scanned 2 KB
  });

  it("survives a malformed percent-escape and still flags the raw text", async () => {
    const { events } = start();
    const base = await server();
    expect(await raw(base, "/a%zz/../b?x=%E0%A4%A")).toBe(200);
    const [e] = await requests(events);
    expect(e!.flags).toEqual(["injection_like"]);
  });

  it("flags auth failures and rate limiting by status", async () => {
    const { events } = start();
    let status = 401;
    const base = await server((_q, s) => {
      s.statusCode = status;
      s.end();
    });
    await raw(base, "/login");
    status = 429;
    await raw(base, "/login");
    expect((await requests(events)).map((e) => e.flags)).toEqual([["auth_failure"], ["rate_limited"]]);
  });

  it("skips ignored paths (defaults and custom)", async () => {
    const { events } = start({ ignore: ["/health", "/assets/*"] });
    const base = await server();
    for (const p of ["/health", "/assets/a.css", "/page"]) await raw(base, p);
    expect((await requests(events)).map((e) => e.route)).toEqual(["/page"]);
  });

  it("applies the default ignore list", async () => {
    const { events } = start();
    const base = await server();
    for (const p of ["/_next/static/chunks/a.js", "/_next/image?url=x", "/favicon.ico", "/robots.txt", "/"]) {
      await raw(base, p);
    }
    expect((await requests(events)).map((e) => e.route)).toEqual(["/"]);
  });
});

describe("client IP", () => {
  it("warns once when trustProxy is 0 and requests come from a local address", async () => {
    const { warnings, events } = start();
    const base = await server();
    await raw(base, "/");
    await raw(base, "/");
    const msgs = warnings.map((w) => (w as Error).message);
    expect(msgs.filter((m) => m.includes("trustProxy: 1"))).toHaveLength(1);
    expect((await requests(events))[0]!.transient?.ip).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it("with trustProxy 1 uses the rightmost X-Forwarded-For entry and does not warn", async () => {
    const { warnings, events } = start({ trustProxy: 1 });
    const base = await server();
    await raw(base, "/", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.5" } });
    await raw(base, "/", { headers: { "x-forwarded-for": "not-an-ip" } });
    const [a, b] = await requests(events);
    expect(a!.transient?.ip).toBe("203.0.113.5");
    expect(b!.transient?.ip).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });
});

describe("transient over plain http", () => {
  const ua = { headers: { "user-agent": "Mozilla/5.0 Firefox/130.0" } };

  it("withholds IP and UA when the endpoint is http to another machine, and warns once", async () => {
    const { warnings, events } = start({ endpoint: "http://ingest.example.com/ingest" });
    const base = await server();
    await raw(base, "/", ua);
    await raw(base, "/", ua);
    const reqs = await requests(events);
    expect(reqs).toHaveLength(2);
    for (const r of reqs) expect(r.transient).toBeUndefined();
    const msgs = warnings.map((w) => (w as Error).message).filter((m) => m.includes("withheld until the endpoint uses https"));
    expect(msgs).toHaveLength(1);
  });

  it.each(["http://127.0.0.1:4318/ingest", "http://localhost:4318/ingest", "http://[::1]:4318/ingest", "https://ingest.example.com/ingest"])(
    "keeps IP and UA for %s",
    async (endpoint) => {
      const { warnings, events } = start({ endpoint });
      const base = await server();
      await raw(base, "/", ua);
      const [r] = await requests(events);
      expect(r!.transient?.ua).toBe("Mozilla/5.0 Firefox/130.0");
      expect(r!.transient?.ip).toBeDefined();
      expect(warnings.some((w) => String((w as Error).message).includes("withheld"))).toBe(false);
    },
  );
});

describe("outbound calls", () => {
  it("records fetch and http.request by host only", async () => {
    const { events } = start();
    const base = await server();
    await (await fetch(`${base}/x?secret=1`)).text();
    await raw(base, "/y?secret=2");
    const out = await events("outbound");
    expect(out).toHaveLength(2);
    for (const o of out) expect(o).toMatchObject({ host: "localhost", method: "GET", status: 200, outcome: "ok" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("records a failed connection as an error", async () => {
    const { events } = start();
    // A port that was just free (port 9 is on fetch's blocked list, so it never connects).
    const closed = await server();
    await new Promise((r) => servers.pop()!.close(r));
    await fetch(closed).catch(() => {});
    expect(await events("outbound")).toMatchObject([{ host: "localhost", outcome: "error" }]);
  });

  it("never reports its own calls to the ingest endpoint", async () => {
    const base = await server();
    const { events } = start({ endpoint: `${base}/ingest` });
    await (await fetch(`${base}/ingest`)).text();
    expect(await events("outbound")).toHaveLength(0);
    expect(await events("request")).toHaveLength(1);
  });
});

describe("linking outbound calls to their inbound request", () => {
  type Linked = { type: string; host?: string; parent_id?: string; event_id: string; route?: string };

  /** An app server whose handler calls `upstream` (fetch, then http.request) before answering. */
  async function appCallingUpstream(upstream: string, delayMs = 0): Promise<string> {
    return server(async (q, s) => {
      const tag = new URL(q.url ?? "/", "http://x").pathname.slice(1);
      await new Promise((r) => setTimeout(r, delayMs));
      await (await fetch(`${upstream}/f?${tag}`)).text();
      await new Promise<void>((r) => http.get(`${upstream}/h?${tag}`, (res) => res.resume().on("end", r)));
      adapter!.captureError(new TypeError("x"));
      s.end(tag);
    });
  }

  // The test client reaches the app by IP (reported as "ip-literal"); the
  // handlers reach the upstream as "localhost". Only the latter are counted.
  const viaIp = (url: string) => url.replace("localhost", "127.0.0.1");
  const byType = (all: Linked[]) => ({
    requests: all.filter((e) => e.type === "request"),
    outbound: all.filter((e) => e.type === "outbound" && e.host === "localhost"),
    errors: all.filter((e) => e.type === "error"),
  });

  it("outbound calls and errors made while handling a request carry its event_id", async () => {
    const { events } = start({ ignore: ["/f", "/h"] });
    const upstream = await server();
    const app = await appCallingUpstream(upstream);
    expect(await raw(viaIp(app), "/one")).toBe(200);
    const { requests, outbound, errors } = byType((await events()) as Linked[]);
    expect(requests).toHaveLength(1);
    expect(outbound).toHaveLength(2);
    for (const e of [...outbound, ...errors]) expect(e.parent_id).toBe(requests[0]!.event_id);
  });

  it("concurrent requests do not cross-link", async () => {
    const { events } = start({ ignore: ["/f", "/h"] });
    const upstream = await server();
    // The first request waits longest, so the two handlers interleave.
    const app = await server(async (q, s) => {
      const tag = new URL(q.url ?? "/", "http://x").pathname.slice(1);
      await new Promise((r) => setTimeout(r, tag === "a" ? 40 : 5));
      await (await fetch(`${upstream}/f?${tag}`)).text();
      s.end(tag);
    });
    await Promise.all([raw(viaIp(app), "/a"), raw(viaIp(app), "/b")]);
    const { requests, outbound } = byType((await events()) as Linked[]);
    expect(requests).toHaveLength(2);
    expect(outbound).toHaveLength(2);
    const ids = new Set(requests.map((r) => r.event_id));
    expect(new Set(outbound.map((o) => o.parent_id))).toEqual(ids);
  });

  it("two requests pipelined in one TCP packet on one socket each link to their own request", async () => {
    const { events } = start({ ignore: ["/f/*"] });
    const upstream = await server();
    const app = await server(async (q, s) => {
      const tag = new URL(q.url ?? "/", "http://x").pathname.slice(1);
      await new Promise((r) => setTimeout(r, tag === "first" ? 30 : 1));
      await (await fetch(`${upstream}/f/${tag}`)).text();
      s.end(tag);
    });
    const { port } = new URL(app);
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(Number(port), "127.0.0.1", () =>
        sock.write("GET /first HTTP/1.1\r\nHost: x\r\n\r\nGET /second HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      );
      sock.on("data", () => {});
      sock.on("end", resolve);
      sock.on("error", reject);
    });
    const all = (await events()) as Linked[];
    const { requests, outbound } = byType(all);
    const idOf = (route: string) => requests.find((r) => r.route === route)!.event_id;
    // Outbound events are captured in completion order: the second request's call finishes first.
    expect(outbound.map((o) => o.parent_id)).toEqual([idOf("/second"), idOf("/first")]);
  });

  it("an outbound call outside any request has no parent_id", async () => {
    const { events } = start();
    const upstream = await server();
    await (await fetch(`${upstream}/x`)).text();
    const [o] = (await events("outbound")) as Linked[];
    expect(o!.parent_id).toBeUndefined();
  });

  it("linkOutbound: false sends no parent_id at all", async () => {
    const { events } = start({ linkOutbound: false, ignore: ["/f", "/h"] });
    const upstream = await server();
    const app = await appCallingUpstream(upstream);
    expect(await raw(viaIp(app), "/one")).toBe(200);
    const all = (await events()) as Linked[];
    expect(byType(all).outbound).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("parent_id");
  });
});

describe("linkOutbound default per Node major", () => {
  it("is on from Node 24, off before", () => {
    expect(defaultLinkOutbound("24.0.0")).toBe(true);
    expect(defaultLinkOutbound("v24.16.0")).toBe(true);
    expect(defaultLinkOutbound("26.1.0")).toBe(true);
    expect(defaultLinkOutbound("22.13.0")).toBe(false);
    expect(defaultLinkOutbound("23.11.1")).toBe(false);
    expect(defaultLinkOutbound("garbage")).toBe(false);
  });

  async function outboundInRequest(opts: NodeOptions) {
    const { events, warnings } = start({ ignore: ["/f"], ...opts });
    const upstream = await server();
    const app = await server(async (_q, s) => {
      await (await fetch(`${upstream}/f`)).text();
      s.end("ok");
    });
    await raw(app.replace("localhost", "127.0.0.1"), "/x");
    const out = (await events("outbound")).filter((e) => (e as { host: string }).host === "localhost");
    const linkWarnings = warnings.filter((w) => String((w as Error).message).includes("linkOutbound: true"));
    return { parent: (out[0] as { parent_id?: string }).parent_id, linkWarnings };
  }

  it("Node 24: linked, no warning", async () => {
    const { parent, linkWarnings } = await outboundInRequest({ nodeVersion: "24.16.0" });
    expect(parent).toBeDefined();
    expect(linkWarnings).toHaveLength(0);
  });

  it("Node 22: off by default with exactly one warning", async () => {
    const { parent, linkWarnings } = await outboundInRequest({ nodeVersion: "22.13.0" });
    expect(parent).toBeUndefined();
    expect(linkWarnings).toHaveLength(1);
    expect((linkWarnings[0] as Error).name).toBe("AbigaailWarning");
  });

  it("Node 22 with linkOutbound: true links and does not warn", async () => {
    const { parent, linkWarnings } = await outboundInRequest({ nodeVersion: "22.13.0", linkOutbound: true });
    expect(parent).toBeDefined();
    expect(linkWarnings).toHaveLength(0);
  });
});

describe("errors", () => {
  it("sends the class name and project-relative frames, never the message", async () => {
    const { events } = start();
    class PaymentFailed extends Error {}
    adapter!.captureError(new PaymentFailed("card 4111-1111 for jane@example.com"), { route: "/pay" });
    const [e] = await events("error");
    expect(e).toMatchObject({ error_type: "PaymentFailed", handled: true, route: "/pay" });
    const frames = (e as { frames?: { file: string }[] }).frames!;
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.file.startsWith("/")).toBe(false);
    expect(frames[0]!.file).toBe("packages/node/test/node.test.ts");
    expect(JSON.stringify(await events())).not.toMatch(/4111|jane/);
  });

  it("handles thrown non-errors", async () => {
    const { events } = start();
    adapter!.captureError("a string with jane@example.com");
    expect(await events("error")).toMatchObject([{ error_type: "NonError" }]);
    expect(JSON.stringify(await events())).not.toContain("jane");
  });
});

describe("fail-open", () => {
  it("a throwing hook inside a channel handler never breaks the response", async () => {
    const { warnings } = start();
    const base = await server((q, s) => {
      Object.defineProperty(q, "url", {
        get() {
          throw new Error("boom");
        },
      });
      s.end("fine");
    });
    expect(await raw(base, "/")).toBe(200);
    expect(warnings.some((w) => (w as Error).message === "boom")).toBe(true);
  });

  it("is a no-op without configuration", async () => {
    const warnings: unknown[] = [];
    const a = init({ env: {}, onInternalError: (e) => warnings.push(e) });
    expect(a.stats().queued).toBe(0);
    a.captureError(new Error("x"));
    expect(a.stats().queued).toBe(0);
    expect(String(warnings[0])).toContain("ABIGAAIL_ENDPOINT");
  });

  it("refuses to start if NEXT_PUBLIC_ABIGAAIL_* is set, naming the variable but not its value", async () => {
    const warnings: unknown[] = [];
    const a = init({
      env: {
        ABIGAAIL_ENDPOINT: "http://127.0.0.1:9/ingest",
        ABIGAAIL_INGEST_KEY: "k",
        NEXT_PUBLIC_ABIGAAIL_INGEST_KEY: "abk_SECRETVALUE",
      },
      onInternalError: (e) => warnings.push(e),
      flushIntervalMs: 0,
    });
    a.captureError(new Error("x"));
    expect(a.stats().queued).toBe(0);
    const msg = String((warnings[0] as Error).message);
    expect(msg).toContain("NEXT_PUBLIC_ABIGAAIL_INGEST_KEY");
    expect(msg).not.toContain("SECRETVALUE");
  });

  it("a second init returns the running instance and does not subscribe twice", async () => {
    const { events } = start();
    expect(init({ env: {} })).toBe(adapter);
    const base = await server();
    await raw(base, "/");
    expect(await requests(events)).toHaveLength(1);
  });

  it("sends boot first and shutdown last", async () => {
    const { batches } = start();
    await adapter!.shutdown(100);
    const kinds = batches.flatMap((b) => b.events).map((e) => (e as { kind?: string }).kind);
    expect(kinds).toEqual(["boot", "shutdown"]);
    adapter = undefined;
  });

  it("sends ABIGAAIL_REGION on boot only, uppercased", async () => {
    const { batches } = start({ env: { ABIGAAIL_REGION: "lon1" }, heartbeatIntervalMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    await adapter!.shutdown(100);
    const life = batches.flatMap((b) => b.events).filter((e) => e.type === "lifecycle");
    expect(life[0]).toMatchObject({ kind: "boot", region: "LON1" });
    expect(life.length).toBeGreaterThan(2);
    for (const e of life.slice(1)) expect(e).not.toHaveProperty("region");
    for (const b of batches) expect(validateBatch(b).ok).toBe(true);
    adapter = undefined;
  });

  it("warns once without the value and sends no region when ABIGAAIL_REGION is invalid", async () => {
    const { batches, warnings } = start({ env: { ABIGAAIL_REGION: "Jane's rack" } });
    await adapter!.shutdown(100);
    const boot = batches.flatMap((b) => b.events).find((e) => e.type === "lifecycle");
    expect(boot).not.toHaveProperty("region");
    const msgs = warnings.map((w) => String((w as Error).message)).filter((m) => m.includes("ABIGAAIL_REGION"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).not.toContain("Jane");
    adapter = undefined;
  });

  it("its timers never keep the process alive", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    start({ metricsIntervalMs: 10, heartbeatIntervalMs: 10, flushIntervalMs: 10 });
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBe(before);
  });

  it("emits valid metrics", async () => {
    const { events } = start({ metricsIntervalMs: 20 });
    await new Promise((r) => setTimeout(r, 70));
    const names = new Set((await events("metric")).map((m) => (m as { name: string }).name));
    for (const n of ["memory_rss_mb", "memory_heap_used_mb", "cpu_percent", "sdk_queue_size", "sdk_dropped_events"]) {
      expect(names.has(n)).toBe(true);
    }
  });
});
