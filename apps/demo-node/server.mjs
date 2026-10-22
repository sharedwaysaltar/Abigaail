// Plain node:http demo for @abigaail/node: `npm run demo:node`.
// Configuration comes from apps/demo-node/.env via `node --env-file`.
// `npm run sim` forks this file with its own environment and drives it (faults.mjs).

import http from "node:http";
import { DEFAULT_IGNORE, init } from "@abigaail/node";
import { DEPENDENCY_MS, faultControl, NORMAL_MS, SLOW_SEARCH_MS } from "./faults.mjs";

const abigaail = init({
  // Demo only: send every second so the Live view feels live. The SDK default stays 5 s.
  flushIntervalMs: 1000,
  // Patterns this app serves; anything else falls back to the ID heuristic.
  routes: ["/", "/user/[id]", "/slow", "/boom", "/outbound", "/dependency-down", "/docs", "/search", "/checkout", "/fetch-error"],
  // The local dependency below runs in this process; its requests are not app traffic.
  ignore: [...DEFAULT_IGNORE, "/__down", "/__dep"],
  // Under the simulator, link outbound calls to requests on every Node version (Node 22
  // defaults to off), so Health's dependency findings have one shape run after run.
  ...(process.env.ABIGAAIL_DEMO_SIM === "1" ? { linkOutbound: true } : {}),
});
const faults = faultControl();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = ([min, max]) => min + Math.random() * (max - min);

// A local dependency: /__down is always down (503); /__dep is healthy unless
// the simulator switches it to failing.
const dependency = http.createServer(async (req, res) => {
  if (req.url === "/__dep" && faults.get().dependency === "ok") {
    await sleep(between(DEPENDENCY_MS));
    res.end("ok");
    return;
  }
  res.statusCode = 503;
  res.end();
});
await new Promise((resolve) => dependency.listen(0, "127.0.0.1", resolve));
dependency.unref();
const depBase = `http://localhost:${dependency.address().port}`;
// A port that was just free, for /fetch-error (port 9 is on fetch's blocked list and never connects).
const closedPort = await new Promise((resolve) => {
  const s = http.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const pages = {
  "/user/42?email=someone@example.com": "Dynamic route (query value must not be stored)",
  "/slow": "Slow handler (~300 ms)",
  "/boom": "Handler that fails (500 + error event; its message is scrubbed: the email becomes <email>)",
  "/fetch-error": "A fetch to a closed port (error with its cause: fetch failed / ECONNREFUSED)",
  "/outbound": "Calls example.com (outbound event)",
  "/dependency-down": "Calls a dependency that is down (failed outbound + 502); reload ~10× for a Health finding",
  "/checkout": "Calls a local dependency (healthy unless the simulator breaks it)",
  "/search": "Search (~60 ms)",
  "/docs": "Docs page",
  "/.env": "Scanner probe (404, unmatched, scanner_path flag)",
};

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  let route;
  try {
    if (path === "/") {
      res.setHeader("content-type", "text/html");
      const items = Object.entries(pages).map(([href, label]) => `<li><a href="${href}">${label}</a></li>`);
      await sleep(between(NORMAL_MS["/"]));
      res.end(`<h1>Abigaail demo (node:http)</h1><ul>${items.join("")}</ul>`);
    } else if (/^\/user\/[^/]+$/.test(path)) {
      route = "/user/[id]";
      await sleep(between(NORMAL_MS[route]));
      if (Math.random() < faults.get().userErrorShare) throw new RangeError("simulated failure");
      res.end(`user ${path.slice(6)}`);
    } else if (path === "/docs") {
      await sleep(between(NORMAL_MS["/docs"]));
      res.end("docs");
    } else if (path === "/search") {
      await sleep(faults.get().slowSearch ? SLOW_SEARCH_MS : between(NORMAL_MS["/search"]));
      res.end("results");
    } else if (path === "/checkout") {
      await sleep(between(NORMAL_MS["/checkout"]));
      const r = await fetch(`${depBase}/__dep`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      res.statusCode = r?.ok ? 200 : 502;
      res.end(r?.ok ? "paid" : "payment provider unavailable");
    } else if (path === "/slow") {
      await sleep(300);
      res.end("slow");
    } else if (path === "/boom") {
      route = "/boom";
      throw new RangeError("Order failed for someone@example.com: the address is replaced before it is sent");
    } else if (path === "/fetch-error") {
      route = "/fetch-error";
      // Nothing listens there: undici throws "fetch failed" with an ECONNREFUSED cause.
      await fetch(`http://localhost:${closedPort}/never`, { signal: AbortSignal.timeout(1000) });
      res.end("unexpected");
    } else if (path === "/outbound") {
      const r = await fetch("https://example.com/?q=never-stored", { signal: AbortSignal.timeout(3000) }).catch(() => null);
      res.end(`example.com answered ${r?.status ?? "nothing (offline?)"}`);
    } else if (path === "/dependency-down") {
      // The dependency answers 503, so this request answers 502.
      const r = await fetch(`${depBase}/__down`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      res.statusCode = r?.ok ? 200 : 502;
      res.end(r?.ok ? "dependency answered" : "dependency is down");
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  } catch (err) {
    abigaail.captureError(err, { route });
    res.statusCode = 500;
    res.end("internal error");
  }
});

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => console.log(`demo-node on http://localhost:${port}`));

// The app owns its signal handling; the SDK never installs signal listeners.
process.once("SIGINT", async () => {
  server.close();
  server.closeAllConnections();
  await abigaail.shutdown();
  process.exit(0);
});
