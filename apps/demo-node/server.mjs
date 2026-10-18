// Plain node:http demo for @abigaail/node: `npm run demo:node`.
// Configuration comes from apps/demo-node/.env via `node --env-file`.

import http from "node:http";
import { init } from "@abigaail/node";

const abigaail = init({
  // Patterns this app serves; anything else falls back to the ID heuristic.
  routes: ["/", "/user/[id]", "/slow", "/boom", "/outbound"],
});

const pages = {
  "/user/42?email=someone@example.com": "Dynamic route (query value must not be stored)",
  "/slow": "Slow handler (~300 ms)",
  "/boom": "Handler that fails (500 + error event)",
  "/outbound": "Calls example.com (outbound event)",
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
