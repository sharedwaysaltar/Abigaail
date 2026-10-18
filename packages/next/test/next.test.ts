import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { current } from "@abigaail/node";
import { loadNextRoutes, onRequestError, register, routeFromRoutePath, type NextOptions } from "@abigaail/next";
import type { Transport } from "@abigaail/core";
import type { Batch } from "@abigaail/schema";
import { validateBatch } from "@abigaail/schema/validate";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const runtime = process.env.NEXT_RUNTIME;

afterEach(async () => {
  await current()?.shutdown(100);
  if (runtime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = runtime;
});

async function start(opts: NextOptions = {}) {
  const batches: Batch[] = [];
  const transport: Transport = async (b) => {
    batches.push(structuredClone(b));
    return "ok";
  };
  process.env.NEXT_RUNTIME = "nodejs";
  await register({
    endpoint: "http://127.0.0.1:9/ingest",
    ingestKey: "k",
    release: "r1",
    environment: "test",
    flushIntervalMs: 0,
    metricsIntervalMs: 0,
    heartbeatIntervalMs: 0,
    transport,
    onInternalError: () => {},
    env: {},
    root: fixture("app"),
    distDir: "build",
    ...opts,
  });
  const events = async () => {
    await current()?.flush();
    for (const b of batches) expect(validateBatch(b)).toMatchObject({ ok: true });
    return batches.flatMap((b) => b.events);
  };
  return { events };
}

describe("routes manifest", () => {
  it("reads static and dynamic pages from a real Next 16 manifest", () => {
    const m = loadNextRoutes(`${fixture("app")}/build`)!;
    expect(m.basePath).toBe("");
    expect(m.routes).toEqual(expect.arrayContaining(["/", "/about", "/api/boom", "/user/[id]"]));
  });

  it("returns undefined when there is no manifest (next dev before a build)", () => {
    expect(loadNextRoutes(`${fixture("app")}/missing`)).toBeUndefined();
  });

  it.each([
    ["app", "/user/5", "/user/[id]"],
    ["app", "/orders/99", "unmatched"],
    ["missing", "/orders/99", "/orders/[id]"],
    ["based", "/shop/user/5", "/shop/user/[id]"],
    ["based", "/shop", "/shop"],
  ])("with manifest %s, GET %s reports %s", async (which, path, expected) => {
    const root = fixture(which === "based" ? "based" : "app");
    const { events } = await start({ root, distDir: which === "missing" ? "missing" : "build" });
    const srv = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => srv.listen(0, r));
    try {
      await (await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}${path}`)).text();
    } finally {
      await new Promise((r) => srv.close(r));
    }
    const req = (await events()).find((e) => e.type === "request");
    expect(req).toMatchObject({ route: expected });
  });
});

describe("register", () => {
  it("does nothing in the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register({ endpoint: "http://127.0.0.1:9/ingest", ingestKey: "k", env: {} });
    expect(current()).toBeUndefined();
  });

  it("never throws, even with a broken error hook", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await expect(
      register({ env: {}, onInternalError: () => { throw new Error("hook"); } }),
    ).resolves.toBeUndefined();
  });
});

describe("onRequestError", () => {
  it.each([
    ["/app/(marketing)/@modal/user/[id]/page", "/user/[id]"],
    ["/app/(marketing)/@modal/user/[id]", "/user/[id]"],
    ["/app/api/boom/route", "/api/boom"],
    ["/src/app/page", "/"],
    ["/pages/api/legacy", "/api/legacy"],
    ["/pages/index", "/"],
    ["/app/files/my file/page", "other"],
  ])("maps routePath %s to %s, in a batch ingest accepts", async (routePath, expected) => {
    const { events } = await start();
    onRequestError(new TypeError("never stored: jane@example.com"), { path: "/x?token=SECRET", headers: { cookie: "c=SECRET" } }, {
      routePath,
      routerKind: "App Router",
      routeType: "render",
    });
    const all = await events();
    const err = all.find((e) => e.type === "error")!;
    expect(err).toMatchObject({ error_type: "TypeError", handled: false, route: expected });
    expect(JSON.stringify(all)).not.toMatch(/SECRET|jane/);
  });

  it("does nothing (and does not throw) when monitoring is not running", () => {
    expect(() => onRequestError(new Error("x"), {}, { routePath: "/app/page" })).not.toThrow();
    expect(current()).toBeUndefined();
  });

  it("routeFromRoutePath strips router dir and file convention", () => {
    expect(routeFromRoutePath("/app/blog/[slug]/page")).toBe("/blog/[slug]");
    expect(routeFromRoutePath("/app/blog/[dynamic]")).toBe("/blog/[dynamic]");
    expect(routeFromRoutePath("/application/x")).toBe("/application/x");
  });
});
