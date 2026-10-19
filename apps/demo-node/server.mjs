// Plain node:http demo for @abigaail/node: `npm run demo:node`.
// Configuration comes from apps/demo-node/.env via `node --env-file`.

import http from "node:http";
import { DEFAULT_IGNORE, init } from "@abigaail/node";

const abigaail = init({
  // Demo only: send every second so the Live view feels live. The SDK default stays 5 s.
  flushIntervalMs: 1000,
  // Patterns this app serves; anything else falls back to the ID heuristic.
  routes: ["/", "/user/[id]", "/slow", "/boom", "/outbound", "/dependency-down"],
  // The fake "down" dependency below runs in this process; its requests are not app traffic.
  ignore: [...DEFAULT_IGNORE, "/__down"],
});

// A dependency that is down: always answers 503.
const down = http.createServer((_req, res) => {
  res.statusCode = 503;
  res.end();
});
await new Promise((resolve) => down.listen(0, "127.0.0.1", resolve));
down.unref();
const downUrl = `http://localhost:${down.address().port}/__down`;

const pages = {
  "/user/42?email=someone@example.com": "Dynamic route (query value must not be stored)",
  "/slow": "Slow handler (~300 ms)",
  "/boom": "Handler that fails (500 + error event)",
  "/outbound": "Calls example.com (outbound event)",
  "/dependency-down": "Calls a dependency that is down (failed outbound + 502); reload ~10× for a Health finding",
  "/.env": "Scanner probe (404, unmatched, scanner_path flag)",
};

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  try {
    if (path === "/") {
      res.setHeader("content-type", "text/html");
      const items = Object.entries(pages).map(([href, label]) => `<li><a href="${href}">${label}</a></li>`);
      res.end(`<h1>Abigaail demo (node:http)</h1><ul>${items.join("")}</ul>`);
    } else if (/^\/user\/[^/]+$/.test(path)) {
      res.end(`user ${path.slice(6)}`);
    } else if (path === "/slow") {
      await new Promise((r) => setTimeout(r, 300));
      res.end("slow");
    } else if (path === "/boom") {
      throw new RangeError("demo failure for someone@example.com (this message must never be stored)");
    } else if (path === "/outbound") {
      const r = await fetch("https://example.com/?q=never-stored", { signal: AbortSignal.timeout(3000) }).catch(() => null);
      res.end(`example.com answered ${r?.status ?? "nothing (offline?)"}`);
    } else if (path === "/dependency-down") {
      // The dependency answers 503, so this request answers 502.
      const r = await fetch(downUrl, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      res.statusCode = r?.ok ? 200 : 502;
      res.end(r?.ok ? "dependency answered" : "dependency is down");
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  } catch (err) {
    abigaail.captureError(err, { route: path === "/boom" ? "/boom" : undefined });
    res.statusCode = 500;
    res.end("internal error");
  }
});

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => console.log(`demo-node on http://localhost:${port}`));

// The app owns its signal handling; the SDK never installs signal listeners.
process.once("SIGINT", async () => {
  server.close();
  await abigaail.shutdown();
  process.exit(0);
});
