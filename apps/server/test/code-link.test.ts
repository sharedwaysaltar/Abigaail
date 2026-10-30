// The optional, read-only GitHub link (DECISIONS #136-#138): only
// https://api.github.com, only paths and hunk line ranges stored (never patch
// text), the token never in the database, a log line, an agent worker or the
// dashboard's data; a refused token is a finding; GitHub down still gives
// findings with their frames; and the diff names the changed lines involved.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releasesView, releaseView } from "@abigaail/insights";
import {
  CODE_LINK_REASONS as REASONS,
  CodeLinks,
  dropGithubTokens,
  GITHUB,
  githubGet,
  loadGithubConfig,
  parseCompare,
  rollout,
  Runner,
  type Fetch,
} from "@abigaail/server";
import { HOUR_MS } from "@abigaail/store";
import { Fx, MIN, NOW } from "./agentfx.js";
import { uuid } from "./helpers.js";

const TOKEN = "github_pat_TOKENMARKER0never0stored0anywhere00";
const MARK = "PATCHMARKER_never_stored";
const REPO = "owner/shop";
const C1 = "1111111111111111111111111111111111111111";
const C2 = "2222222222222222222222222222222222222222";

const COMPARE = {
  files: [
    { filename: "src/checkout.ts", status: "modified", patch: `@@ -10,4 +10,6 @@ export function applyDiscount(cart) {\n context\n-${MARK} old\n+${MARK} new\n+${MARK} more\n context` },
    { filename: "src/other.ts", status: "modified", patch: `@@ -40,2 +40,2 @@\n-${MARK}\n+${MARK}` },
    { filename: "assets/logo.png", status: "added" },
    { filename: "/etc/passwd", status: "modified", patch: "@@ -1 +1 @@" },
    { filename: "../outside.ts", status: "modified", patch: "@@ -1 +1 @@" },
  ],
};

interface Call {
  url: string;
  init: RequestInit;
}
/** A stand-in for fetch: records every call and answers from `answer`. */
function fakeFetch(answer: (url: URL) => Response | Promise<Response>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer(new URL(url));
    },
  };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const github = (url: URL) =>
  url.pathname === `/repos/${REPO}/compare/${C1}...${C2}` ? json(200, COMPARE) : url.pathname === `/repos/${REPO}` ? json(200, { full_name: REPO }) : json(404, {});

let fx: Fx;
let logs: string[];
beforeEach(() => {
  fx = new Fx("shop");
  logs = [];
});
afterEach(() => fx.close());

/** 13:50 UTC: 40 min before NOW. */
const DEPLOY = NOW - 40 * MIN;
const END = NOW - 45_000;
const mix = (status = (_route: string, _i: number) => 200) => (i: number) => {
  const route = i % 20 < 3 ? "/checkout" : "/";
  return { route, status: status(route, i), duration: 50 };
};
const FRAME = { file: "src/checkout.ts", line: 12, fn: "applyDiscount" };

function deployEvent(ts: number, release: string, commit: string): void {
  fx.store.insertBatch(fx.appId, { receivedAt: ts, release, environment: "test", events: [{ event: { type: "deploy", event_id: uuid(), client_ts: ts, commit }, derived: { ts } }] });
}

/** r1 (commit C1) for weeks, then r2 (commit C2) breaks /checkout with a TypeError at src/checkout.ts:12. */
function badRelease(): void {
  for (const at of [NOW - HOUR_MS, NOW]) fx.baselineWeeks(at, 4, (h) => fx.requests(h, h + HOUR_MS, 1200, mix()));
  deployEvent(NOW - 5 * HOUR_MS, "r1", C1);
  fx.requests(DEPLOY - 30 * MIN, DEPLOY, 600, mix());
  fx.start(DEPLOY, { release: "r2" });
  deployEvent(DEPLOY + 1_000, "r2", C2);
  fx.requests(DEPLOY + 2_000, END, Math.round((END - DEPLOY) / MIN) * 20, mix((route, i) => (route === "/checkout" && i % 2 === 0 ? 500 : 200)), "r2");
  for (let k = 0; k < 20; k++) fx.error(DEPLOY + 60_000 + k * MIN, "TypeError", "/checkout", FRAME, "r2");
}

function job(f: Fetch): CodeLinks {
  return new CodeLinks({ store: fx.store, links: [{ app: "shop", repo: REPO, token: TOKEN }], fetch: f, now: () => fx.now, log: (m) => logs.push(m) });
}

/** Two Rollout runs a minute apart, recorded as the runner does. */
function twoRuns() {
  fx.now = NOW - MIN;
  fx.runAndRecord(rollout);
  fx.now = NOW;
  fx.runAndRecord(rollout);
  return fx.store.openFindings(fx.appId);
}

/** Every byte of the database and its WAL, and every table as JSON. */
function everywhere(): string[] {
  const out: string[] = [];
  for (const p of [fx.dbPath, `${fx.dbPath}-wal`]) if (existsSync(p)) out.push(readFileSync(p).toString("latin1"));
  const db = fx.store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } };
  for (const t of db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    out.push(JSON.stringify(db.db.prepare(`SELECT * FROM "${t.name}"`).all()));
  }
  return out;
}

describe("configuration", () => {
  it("one fine-grained token and one repository per app; the message names the variable, never the value", () => {
    expect(loadGithubConfig({ ABIGAAIL_GITHUB_REPO_MY_SHOP: REPO, ABIGAAIL_GITHUB_TOKEN_MY_SHOP: TOKEN })).toEqual([{ app: "my-shop", repo: REPO, token: TOKEN }]);
    expect(loadGithubConfig({})).toEqual([]);
    const classic = "ghp_CLASSICTOKENVALUE00000000000000000000";
    expect(() => loadGithubConfig({ ABIGAAIL_GITHUB_REPO_SHOP: REPO, ABIGAAIL_GITHUB_TOKEN_SHOP: classic })).toThrow(/ABIGAAIL_GITHUB_TOKEN_SHOP must be a fine-grained token/);
    try {
      loadGithubConfig({ ABIGAAIL_GITHUB_REPO_SHOP: REPO, ABIGAAIL_GITHUB_TOKEN_SHOP: classic });
    } catch (err) {
      expect(String(err)).not.toContain(classic);
    }
    expect(() => loadGithubConfig({ ABIGAAIL_GITHUB_TOKEN_SHOP: TOKEN })).toThrow(/ABIGAAIL_GITHUB_REPO_SHOP is not/);
    expect(() => loadGithubConfig({ ABIGAAIL_GITHUB_REPO_SHOP: REPO })).toThrow(/ABIGAAIL_GITHUB_TOKEN_SHOP is not/);
    expect(() => loadGithubConfig({ ABIGAAIL_GITHUB_REPO_SHOP: "https://github.com/owner/shop", ABIGAAIL_GITHUB_TOKEN_SHOP: TOKEN })).toThrow(/must be owner\/name/);
  });

  it("the server drops the tokens from its environment once read", () => {
    const env: NodeJS.ProcessEnv = { ABIGAAIL_GITHUB_REPO_SHOP: REPO, ABIGAAIL_GITHUB_TOKEN_SHOP: TOKEN, PATH: "/bin" };
    loadGithubConfig(env);
    dropGithubTokens(env);
    expect(env).toEqual({ ABIGAAIL_GITHUB_REPO_SHOP: REPO, PATH: "/bin" });
  });
});

describe("what is asked, and what is kept", () => {
  it("calls only https://api.github.com, never following a redirect, with the token only in the Authorization header", async () => {
    badRelease();
    const f = fakeFetch(github);
    await job(f.fetch).runOnce();
    expect(f.calls.length).toBe(1);
    for (const c of f.calls) {
      expect(new URL(c.url).origin).toBe("https://api.github.com");
      expect(c.url).toBe(`https://api.github.com/repos/${REPO}/compare/${C1}...${C2}`);
      expect(c.init.redirect).toBe("error");
      expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
    }
    // A path that would leave api.github.com is refused before any call.
    for (const path of ["//evil.example/repos/x", "https://evil.example/repos/x", "/user", "/repos/../user"]) {
      await expect(githubGet(f.fetch, path, TOKEN)).rejects.toThrow(RangeError);
    }
    expect(f.calls.length).toBe(1);
  });

  it("stores paths and hunk line ranges only: no patch text, no token, in any table or byte of the database and its WAL", async () => {
    badRelease();
    await job(fakeFetch(github).fetch).runOnce();
    expect(fx.store.codeDiff(fx.appId, "r2")).toMatchObject({ status: "ok", base_commit: C1, head_commit: C2, files: 3, repo: REPO });
    expect(fx.store.codeHunks(fx.appId, "r2")).toEqual([
      { file: "assets/logo.png", previous_file: null, change: "added", start_line: null, end_line: null },
      { file: "src/checkout.ts", previous_file: null, change: "modified", start_line: 10, end_line: 15 },
      { file: "src/other.ts", previous_file: null, change: "modified", start_line: 40, end_line: 41 },
    ]);
    expect(fx.store.codeLink(fx.appId)).toMatchObject({ repo: REPO, state: "ok" });
    const all = everywhere();
    expect(statSync(`${fx.dbPath}-wal`).size).toBeGreaterThan(0);
    for (const s of all) {
      expect(s).not.toContain(MARK);
      expect(s).not.toContain(TOKEN);
    }
    fx.store.checkpoint();
    for (const s of everywhere()) {
      expect(s).not.toContain(MARK);
      expect(s).not.toContain(TOKEN);
    }
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("parseCompare keeps the '@@' line ranges and nothing of the patch; odd paths are left out", () => {
    const parsed = parseCompare({
      files: [
        ...COMPARE.files,
        { filename: "src/removed-lines.ts", status: "modified", patch: "@@ -5,3 +4,0 @@\n-a\n-b\n-c" },
        { filename: "src/new.ts", status: "renamed", previous_filename: "src/old.ts", patch: "@@ -1 +1 @@\n-x\n+y\n@@ -20,2 +20,3 @@\n a" },
      ],
    })!;
    expect(JSON.stringify(parsed)).not.toContain(MARK);
    expect(parsed.hunks.filter((h) => h.file === "src/removed-lines.ts")).toEqual([{ file: "src/removed-lines.ts", previous_file: null, change: "modified", start_line: 4, end_line: 4 }]);
    expect(parsed.hunks.filter((h) => h.file === "src/new.ts").map((h) => [h.previous_file, h.start_line, h.end_line])).toEqual([["src/old.ts", 1, 1], ["src/old.ts", 20, 22]]);
    expect(parsed.hunks.some((h) => h.file.includes("passwd") || h.file.includes(".."))).toBe(false);
    expect(parseCompare({ message: "no files" })).toBeUndefined();
    expect(parseCompare({ files: Array.from({ length: 400 }, (_, i) => ({ filename: `f${i}.ts`, status: "added" })) })).toMatchObject({ files: 300, truncated: true });
  });

  it("a compare is cached for good; a failure is retried later with back-off", async () => {
    badRelease();
    let down = true;
    const f = fakeFetch((url) => (down ? Promise.reject(new TypeError("fetch failed")) : github(url)));
    const j = job(f.fetch);
    await j.runOnce();
    expect(fx.store.codeDiff(fx.appId, "r2")).toMatchObject({ status: "failed", reason: REASONS.unreachable, tries: 1, next_try_at: NOW + GITHUB.retryMs });
    await j.runOnce();
    expect(f.calls.length).toBe(1);
    down = false;
    fx.now = NOW + GITHUB.retryMs;
    await j.runOnce();
    expect(fx.store.codeDiff(fx.appId, "r2")).toMatchObject({ status: "ok", tries: 2 });
    fx.now += HOUR_MS;
    await j.runOnce();
    expect(f.calls.length).toBe(2);
  });
});

describe("findings", () => {
  it("the finding names the changed lines its error comes from, with a github.com link to them", async () => {
    badRelease();
    await job(fakeFetch(github).fetch).runOnce();
    const f = twoRuns().find((x) => x.fingerprint === "rollout:release:r2")!;
    expect(f.severity).toBe("critical");
    expect(f.summary).toContain("Changed code involved: src/checkout.ts:12 (applyDiscount), lines 10-15, changed in r2.");
    expect(f.action).toContain("look at the changed lines");
    const code = f.evidence.code as { status: string; involved: { url: string; match: string }[] };
    expect(code.status).toBe("ok");
    expect(code.involved[0]).toMatchObject({ file: "src/checkout.ts", line: 12, match: "line", lines: [10, 15], url: `https://github.com/${REPO}/blob/${C2}/src/checkout.ts#L10-L15` });
    // The Releases view says the same.
    const v = releaseView(fx.store, fx.appId, "r2", NOW)!;
    expect(v.code).toMatchObject({ status: "ok", repo: REPO, files: 3, linkFailed: null });
    expect(v.code!.involved[0]).toMatchObject({ file: "src/checkout.ts", line: 12, what: "TypeError on /checkout", match: "line" });
  });

  it("GitHub down: Rollout still recommends the rollback, with the error's frames, without changed lines", async () => {
    badRelease();
    await job(fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).fetch).runOnce();
    const f = twoRuns().find((x) => x.fingerprint === "rollout:release:r2")!;
    expect(f.severity).toBe("critical");
    expect(f.summary).toMatch(/^Recommend rollback: release r2/);
    expect(f.summary).not.toContain("Changed code involved");
    expect(f.evidence.frames).toContainEqual({ ...FRAME, what: "TypeError on /checkout" });
    expect(f.evidence.code).toMatchObject({ status: "failed", why: REASONS.unreachable, involved: [] });
    expect(releaseView(fx.store, fx.appId, "r2", NOW)!.errors[0]).toMatchObject({ file: FRAME.file, line: FRAME.line, fn: FRAME.fn });
  });

  it("without a link the finding is as before, with its frames", () => {
    badRelease();
    const f = twoRuns().find((x) => x.fingerprint === "rollout:release:r2")!;
    expect(f.severity).toBe("critical");
    expect(f.evidence.frames).toContainEqual({ ...FRAME, what: "TypeError on /checkout" });
    expect(f.evidence.code).toMatchObject({ status: "off", involved: [] });
    expect(releaseView(fx.store, fx.appId, "r2", NOW)!.code).toBeNull();
  });

  it("a 401: the link is marked failed and Rollout says 'token expired or revoked: create a new one'; the app is not asked again for an hour", async () => {
    badRelease();
    const f = fakeFetch(() => json(401, { message: "Bad credentials" }));
    const j = job(f.fetch);
    await j.runOnce();
    expect(fx.store.codeLink(fx.appId)).toMatchObject({ state: "failed", reason: "token expired or revoked: create a new one" });
    const findings = twoRuns();
    const failed = findings.find((x) => x.fingerprint === "rollout:code_link_failed:")!;
    expect(failed).toMatchObject({ severity: "warning", resolves: "fact" });
    expect(failed.summary).toBe(`The read-only GitHub link for shop (${REPO}) fails: token expired or revoked: create a new one. Findings still name their frames, but not the changed lines.`);
    expect(failed.action).toContain("ABIGAAIL_GITHUB_TOKEN_SHOP");
    expect(failed.action).toContain("Contents: read");
    // The release is still judged, with its frames.
    expect(findings.find((x) => x.fingerprint === "rollout:release:r2")).toMatchObject({ severity: "critical" });
    expect(logs).toEqual([`github: shop: ${REASONS.revoked} (ABIGAAIL_GITHUB_TOKEN_SHOP)`]);
    await j.runOnce();
    expect(f.calls.length).toBe(1);
    fx.now = NOW + GITHUB.refusedRetryMs;
    await j.runOnce();
    expect(f.calls.length).toBe(2);
  });

  it("a failed link is asked again: a new token turns it ok though every diff is cached, and the finding resolves", async () => {
    badRelease();
    await job(fakeFetch(github).fetch).runOnce();
    fx.store.setCodeLink(fx.appId, REPO, "failed", REASONS.revoked);
    // After a restart with a new token: nothing is due (the diff is cached), the link is still checked.
    const f = fakeFetch(github);
    await job(f.fetch).runOnce();
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([`/repos/${REPO}`]);
    expect(fx.store.codeLink(fx.appId)).toMatchObject({ state: "ok", reason: null });
    expect(twoRuns().find((x) => x.fingerprint === "rollout:code_link_failed:")).toBeUndefined();
  });

  it("a token without access to the repository, and a commit not on GitHub, are told apart", async () => {
    badRelease();
    await job(fakeFetch((url) => (url.pathname === `/repos/${REPO}` ? json(404, {}) : json(404, {}))).fetch).runOnce();
    expect(fx.store.codeLink(fx.appId)).toMatchObject({ state: "failed", reason: REASONS.noRepo });
    const fx2 = fx;
    fx2.store.setCodeLink(fx2.appId, REPO, "ok", null);
    fx.now += 2 * HOUR_MS;
    await job(fakeFetch((url) => (url.pathname === `/repos/${REPO}` ? json(200, {}) : json(404, {}))).fetch).runOnce();
    expect(fx.store.codeLink(fx.appId)).toMatchObject({ state: "ok" });
    expect(fx.store.codeDiff(fx.appId, "r2")).toMatchObject({ status: "not_found", reason: REASONS.noCommit });
  });
});

describe("where the token never goes", () => {
  it("not into an agent worker's environment", async () => {
    process.env.ABIGAAIL_GITHUB_TOKEN_SHOP = TOKEN;
    try {
      const runner = new Runner({
        store: fx.store,
        dbPath: fx.dbPath,
        agents: [{ name: "env", everyMs: 60_000, timeoutMs: 2_000 }],
        workerUrl: new URL("./fixtures/env.mjs", import.meta.url),
        log: (m) => logs.push(m),
      });
      const r = await runner.runAgent("env");
      await runner.stop();
      expect(r.run.outcome).toBe("ok");
      const f = fx.store.systemFindings().find((x) => x.signal === "env")!;
      expect(JSON.stringify(f.evidence)).not.toContain(TOKEN);
      expect(Object.keys(f.evidence.env as object).filter((k) => k.startsWith("ABIGAAIL_"))).toEqual([]);
    } finally {
      delete process.env.ABIGAAIL_GITHUB_TOKEN_SHOP;
    }
  });

  it("not into the dashboard's data, and the dashboard never reads it", async () => {
    badRelease();
    await job(fakeFetch(github).fetch).runOnce();
    twoRuns();
    const data = JSON.stringify([releasesView(fx.store, fx.appId), releaseView(fx.store, fx.appId, "r2", NOW), fx.store.openFindings(fx.appId)]);
    expect(data).toContain("src/checkout.ts");
    expect(data).not.toContain(TOKEN);
    expect(data).not.toContain(MARK);
    const dashboard = join(import.meta.dirname, "../../dashboard");
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === "node_modules" || e.name === ".next" ? [] : e.isDirectory() ? sources(join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    for (const file of sources(dashboard)) expect(readFileSync(file, "utf8"), file).not.toMatch(/ABIGAAIL_GITHUB_TOKEN|api\.github\.com/);
  });
});
