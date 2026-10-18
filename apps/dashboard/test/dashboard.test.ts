import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REGION_RE } from "@abigaail/schema";
import { openReadOnly, openStore } from "@abigaail/store";
import { span } from "../lib/format";
import { sameOrigin } from "../lib/http";
import { livenessText } from "../lib/liveness";
import { REGIONS } from "../lib/regions";
import { LAND, MAP } from "../lib/worldmap";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

// The only entry points that may run without a session.
const PUBLIC = new Set(["app/login/page.tsx", "app/api/login/route.ts"]);

describe("every page and route handler requires a session", () => {
  const entries = files(join(ROOT, "app"))
    .map((p) => relative(ROOT, p))
    .filter((p) => /(^|\/)(page|route)\.tsx?$/.test(p));

  it("finds the entry points", () => {
    expect(entries).toContain("app/(dash)/page.tsx");
    expect(entries).toContain("app/(dash)/apps/[name]/page.tsx");
    expect(entries).toContain("app/api/logout/route.ts");
  });

  it.each(entries.filter((p) => !PUBLIC.has(p)))("%s calls requireSession() itself", (p) => {
    const src = readFileSync(join(ROOT, p), "utf8");
    expect(src).toMatch(/import \{[^}]*\brequireSession\b[^}]*\} from "@\/lib\/session"/);
    // Called in every exported page/handler, before anything else reads data.
    const exported = src.split(/export (?:default )?async function /).slice(1);
    expect(exported.length).toBeGreaterThan(0);
    // The body opens with `) {` or `): Type {` at the end of the signature line.
    for (const body of exported) {
      expect(body).toMatch(/^[^\n]*\)(?::[^\n{]+)?\s*\{\n\s*(?:if \(!sameOrigin\(req\)\)[^\n]*\n\s*)?(?:const \{ user \} = )?await requireSession\(\);/);
    }
  });

  it("the public entry points are only sign-in", () => {
    for (const p of PUBLIC) expect(entries).toContain(p);
  });

  it("POST handlers check the Origin", () => {
    for (const p of entries.filter((e) => e.endsWith("route.ts"))) {
      const src = readFileSync(join(ROOT, p), "utf8");
      if (src.includes("export async function POST")) expect(src).toContain("if (!sameOrigin(req))");
    }
  });
});

describe("the dashboard is read-only on the monitoring store", () => {
  it("opens it only through openReadOnly, and never imports the writable Store", () => {
    const sources = [...files(join(ROOT, "app")), ...files(join(ROOT, "lib")), ...files(join(ROOT, "components"))].filter((p) => /\.(ts|tsx)$/.test(p));
    for (const p of sources) {
      const src = readFileSync(p, "utf8");
      expect(src, relative(ROOT, p)).not.toMatch(/\bopenStore\b|\bnew Store\b|\bStore\b,|type Store\b/);
    }
    expect(readFileSync(join(ROOT, "lib/data.ts"), "utf8")).toContain("openReadOnly(dashboardConfig().dbPath)");
  });

  it("a read-only connection refuses writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "abigaail-dash-"));
    try {
      const path = join(dir, "m.db");
      openStore(path).close();
      const r = openReadOnly(path);
      const db = (r as unknown as { db: { exec(sql: string): void } }).db;
      expect(() => db.exec("INSERT INTO audit_log (ts, actor, action) VALUES (1, 'x', 'y')")).toThrow(/readonly/i);
      r.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("regions and map", () => {
  it("every region code is one the SDK can send, with real coordinates", () => {
    for (const [code, r] of Object.entries(REGIONS)) {
      expect(code).toMatch(REGION_RE);
      expect(Math.abs(r.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(r.lon)).toBeLessThanOrEqual(180);
      expect(r.lat).toBeLessThan(MAP.top);
      expect(r.lat).toBeGreaterThan(MAP.bottom);
    }
  });

  it("the land grid has the declared shape and London is on land", () => {
    expect(LAND).toHaveLength(MAP.rows);
    for (const row of LAND) expect(row).toHaveLength(MAP.cols);
    const london = REGIONS.LON1!;
    const col = Math.floor((london.lon + 180) / MAP.cell);
    const row = Math.floor((MAP.top - london.lat) / MAP.cell);
    expect(LAND[row]![col]).toBe("#");
  });
});

describe("uptime wording", () => {
  it("is process uptime, said as such, never a percentage", () => {
    const now = 10 * 86_400_000;
    const texts = [
      livenessText({ kind: "running", since: now - 3 * 86_400_000 - 4 * 3_600_000 }, now),
      livenessText({ kind: "silent", since: now - 12 * 60_000 }, now),
      livenessText({ kind: "stopped", since: now - 2 * 3_600_000 }, now),
      livenessText({ kind: "never" }, now),
    ];
    expect(texts).toEqual(["Running for 3 d 4 h", "Silent for 12 min", "Stopped 2 h ago", "No events yet"]);
    for (const t of texts) expect(t).not.toContain("%");
    expect(span(59_000)).toBe("59 s");
  });
});

describe("sameOrigin (CSRF check on POST)", () => {
  const post = (headers: Record<string, string>) => new Request("http://localhost:4319/api/login", { method: "POST", headers });

  it("accepts Sec-Fetch-Site: same-origin, even with Origin: null", () => {
    expect(sameOrigin(post({ "sec-fetch-site": "same-origin", origin: "null", host: "localhost:4319" }))).toBe(true);
    expect(sameOrigin(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("rejects cross-site, same-site and none, whatever Origin says", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(sameOrigin(post({ "sec-fetch-site": site, origin: "http://localhost:4319", host: "localhost:4319" }))).toBe(false);
    }
  });

  it("without Sec-Fetch-Site, needs an Origin naming this host", () => {
    expect(sameOrigin(post({ origin: "http://localhost:4319", host: "localhost:4319" }))).toBe(true);
    expect(sameOrigin(post({ origin: "https://evil.example", host: "localhost:4319" }))).toBe(false);
    expect(sameOrigin(post({ origin: "null", host: "localhost:4319" }))).toBe(false);
    expect(sameOrigin(post({ host: "localhost:4319" }))).toBe(false);
    expect(sameOrigin(post({}))).toBe(false);
  });
});

describe("referrer policy", () => {
  // "no-referrer" makes Chromium send "Origin: null" on our own form posts, which sameOrigin() refuses.
  it("the wrapper and the page metadata never use no-referrer", () => {
    const server = readFileSync(join(ROOT, "server.mjs"), "utf8");
    const header = /setHeader\("referrer-policy", "([^"]+)"\)/.exec(server);
    expect(header?.[1]).toBe("same-origin");
    const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
    expect(layout).toMatch(/referrer: "same-origin"/);
    expect(server + layout).not.toMatch(/["']no-referrer["']/);
  });
});
