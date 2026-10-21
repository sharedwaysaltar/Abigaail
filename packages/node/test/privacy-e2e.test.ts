// End to end through the real Node adapter (DECISIONS #106): personal data in
// every position an app can hand it over (paths, query values, headers,
// bodies, error messages, codes, causes, custom properties, thrown
// non-Errors, outbound URLs with credentials and query values) never appears,
// in any encoding, in the batches the SDK sends.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { init, type AbigaailNode } from "@abigaail/node";
import type { Transport } from "@abigaail/core";
import type { Batch } from "@abigaail/schema";
import { validateBatch } from "@abigaail/schema/validate";
import { encode, leaks, pii, rng, type Pii } from "../../schema/test/pii.js";

let adapter: AbigaailNode | undefined;
const servers: http.Server[] = [];
afterEach(async () => {
  await adapter?.shutdown(100);
  adapter = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer({ maxHeaderSize: 256 * 1024 }, handler);
  servers.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

function request(base: string, path: string, headers: Record<string, string>, body?: string): Promise<void> {
  return new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path, method: body ? "POST" : "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.end(body);
  });
}

const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "x");

describe("no personal data leaves the app through the Node adapter", () => {
  it("in any position, in any encoding", async () => {
    const batches: Batch[] = [];
    const transport: Transport = async (b) => {
      batches.push(structuredClone(b));
      return "ok";
    };
    adapter = init({
      endpoint: "http://127.0.0.1:9/ingest", ingestKey: "k", release: "r1", environment: "test", flushIntervalMs: 0,
      metricsIntervalMs: 0, heartbeatIntervalMs: 0, transport, env: {}, nodeVersion: "24.0.0", maxScrubsPerSecond: 100_000,
      onInternalError: () => {},
    });
    const planted: Pii[] = [];
    const r = rng(2026);
    const take = () => {
      const v = r() < 0.5 ? encode(r, pii(r)) : pii(r);
      planted.push(v);
      return v.text;
    };

    // A dependency, so outbound calls carry personal data in their URLs.
    const dep = await listen((_q, s) => s.end("ok"));
    // A port that was just free, so a call to it is refused (port 9 is on fetch's blocked list).
    const closed = await listen((_q, s) => s.end());
    await new Promise((d) => servers.pop()!.close(d));
    const app = await listen(async (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      await new Promise((d) => req.on("end", d));
      try {
        const kind = (req.url ?? "").split("/")[1];
        if (kind === "throw") {
          const err = new Error(`Order failed for ${take()} with ${take()}`) as Error & Record<string, unknown>;
          err.code = take();
          err.email = take();
          err.detail = `Key (email)=(${take()}) already exists.`;
          err.cause = Object.assign(new TypeError(`connect failed for ${take()}`), { code: take() });
          err.stack = `Error: x\n    at handler (/home/${ascii(take())}/app/src/server.ts:12:5)\n    at /Users/${ascii(take())}/src/x.ts:1:1`;
          throw err;
        }
        if (kind === "throw-string") throw `User ${take()} not found`;
        if (kind === "throw-object") throw { email: take(), message: take() };
        if (kind === "outbound") {
          await fetch(`${dep}/users/${encodeURIComponent(take())}?email=${encodeURIComponent(take())}&token=${encodeURIComponent(take())}`).catch(() => null);
          const u = new URL(dep);
          await new Promise<void>((done) => {
            const q = http.request({ host: u.hostname, port: u.port, path: `/x?q=${encodeURIComponent(take())}`, auth: `${ascii(take())}:${ascii(take())}` }, (s) => {
              s.resume();
              s.on("end", () => done());
            });
            q.on("error", () => done());
            q.end();
          });
          // A failing call whose error message would carry the URL.
          await fetch(`${closed}/${encodeURIComponent(take())}`).catch(() => null);
        }
        res.end("ok");
      } catch (err) {
        adapter!.captureError(err);
        res.statusCode = 500;
        res.end("error");
      }
    });

    for (let i = 0; i < 25; i++) {
      const headers = {
        cookie: `session=${encodeURIComponent(take())}; email=${encodeURIComponent(take())}`,
        authorization: `Bearer ${encodeURIComponent(take())}`,
        referer: `https://shop.example.com/account/${encodeURIComponent(take())}?email=${encodeURIComponent(take())}`,
        "x-forwarded-for": "203.0.113.77",
        "x-user": encodeURIComponent(take()),
        "content-type": "application/x-www-form-urlencoded",
      };
      const path = `/${encodeURIComponent(take())}/${encodeURIComponent(take())}?email=${encodeURIComponent(take())}&q=${encodeURIComponent(take())}`;
      await request(app, path, headers, `name=${encodeURIComponent(take())}&card=${encodeURIComponent(take())}`);
      for (const kind of ["throw", "throw-string", "throw-object", "outbound"]) await request(app, `/${kind}`, headers);
    }
    await adapter.flush();

    const sent = JSON.stringify(batches);
    for (const b of batches) expect(validateBatch(b)).toMatchObject({ ok: true });
    // Not vacuous: errors with scrubbed messages and causes, outbound calls with codes went out.
    const events = batches.flatMap((b) => b.events);
    expect(events.filter((e) => e.type === "error" && e.message).length).toBeGreaterThan(20);
    expect(events.filter((e) => e.type === "error" && e.cause_type).length).toBeGreaterThan(10);
    expect(events.filter((e) => e.type === "outbound" && e.error_code).length).toBeGreaterThan(10);
    expect(planted.length).toBeGreaterThan(700);

    const found = planted.flatMap((p) => leaks(sent, p).map((n) => `${p.kind}: ${n}`));
    for (const f of found.slice(0, 6)) {
      const n = f.slice(f.indexOf(": ") + 2).replace(/^digits /, "");
      const at = sent.toLowerCase().indexOf(n.toLowerCase());
      process.stdout.write(`LEAK ${f} :: ${at >= 0 ? sent.slice(Math.max(0, at - 220), at + 60) : "(digits)"}\n`);
    }
    expect([...new Set(found)].slice(0, 20)).toEqual([]);
    expect(sent).not.toContain("203.0.113.77");
    expect(sent).not.toMatch(/\/home\/|\/Users\//);
  }, 60_000);
});
