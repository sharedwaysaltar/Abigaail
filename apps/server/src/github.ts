// The optional, read-only GitHub link (DECISIONS #136-#138). Per app, a
// fine-grained token (github_pat_…) for one repository with Contents: read.
// It runs here, in the server's main thread: the token lives only in this
// process's memory (read from the environment, then removed from it), never in
// the database, a log line, an agent worker or the dashboard. It calls only
// https://api.github.com, never follows a redirect, reads at most
// GITHUB.maxBytes, and keeps from GitHub's compare only paths and each hunk's
// line range on the new side; the patch text is read for its "@@" headers and
// dropped. With GitHub down, findings carry their frames as before.

import { isFramePath } from "@abigaail/schema";
import type { CodeHunk, Store } from "@abigaail/store";
import { errorClass } from "./agents/evaluate.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const GITHUB = {
  /** The only origin ever called. */
  origin: "https://api.github.com",
  timeoutMs: 10_000,
  /** A compare's JSON (it carries every file's patch) is read up to this size. */
  maxBytes: 8 * 1024 * 1024,
  /** GitHub's compare lists at most 300 files. */
  maxFiles: 300,
  maxHunksPerFile: 50,
  everyMs: MIN,
  /** Releases deployed this long ago or less are fetched. */
  fetchWindowMs: 7 * DAY,
  /** At most this many compares per app and run. */
  perRun: 3,
  /** Retries after a failure: 5 min, doubling, at most 6 h; at most maxTries in all. */
  retryMs: 5 * MIN,
  retryMaxMs: 6 * HOUR,
  maxTries: 10,
  /** After the token was refused, the app is asked again this much later (the token changes only with a restart). */
  refusedRetryMs: HOUR,
  /** Diffs of releases last seen longer ago are forgotten. */
  keepMs: 30 * DAY,
} as const;

export const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{22,255}$/;
export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** Fixed reasons, stored and shown as they are (never GitHub's own words). */
export const REASONS = {
  revoked: "token expired or revoked: create a new one",
  forbidden: "the token cannot read this repository: give it Contents: read on it",
  noRepo: "the token cannot see this repository: check its name and the token's repository access",
  noCommit: "a commit is not on GitHub: push it, or check ABIGAAIL_COMMIT",
  unreachable: "GitHub could not be reached; retrying",
  rateLimited: "GitHub's rate limit was reached; retrying",
  tooLarge: "the diff is too large to fetch",
  badAnswer: "GitHub answered something unexpected; retrying",
} as const;

export interface CodeLinkConfig {
  /** App name. */
  app: string;
  repo: string;
  token: string;
}

const envSuffix = (app: string) => app.toUpperCase().replace(/-/g, "_");

/**
 * Links from ABIGAAIL_GITHUB_REPO_<APP> (owner/name) and
 * ABIGAAIL_GITHUB_TOKEN_<APP> (<APP>: the app's name in capitals, "-" as "_").
 * A set but invalid value throws, so the server does not start; the message
 * names the variable, never its value.
 */
export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env): CodeLinkConfig[] {
  const out: CodeLinkConfig[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(env).sort()) {
    const repoKey = /^ABIGAAIL_GITHUB_REPO_([A-Z0-9_]+)$/.exec(key);
    const tokenKey = /^ABIGAAIL_GITHUB_TOKEN_([A-Z0-9_]+)$/.exec(key);
    const suffix = repoKey?.[1] ?? tokenKey?.[1];
    if (!suffix || seen.has(suffix) || !(env[`ABIGAAIL_GITHUB_REPO_${suffix}`]?.trim() || env[`ABIGAAIL_GITHUB_TOKEN_${suffix}`]?.trim())) continue;
    seen.add(suffix);
    const repo = env[`ABIGAAIL_GITHUB_REPO_${suffix}`]?.trim() ?? "";
    const token = env[`ABIGAAIL_GITHUB_TOKEN_${suffix}`]?.trim() ?? "";
    if (!repo) throw new Error(`ABIGAAIL_GITHUB_TOKEN_${suffix} is set but ABIGAAIL_GITHUB_REPO_${suffix} is not`);
    if (!REPO_RE.test(repo)) throw new Error(`ABIGAAIL_GITHUB_REPO_${suffix} must be owner/name`);
    if (!token) throw new Error(`ABIGAAIL_GITHUB_REPO_${suffix} is set but ABIGAAIL_GITHUB_TOKEN_${suffix} is not`);
    if (!TOKEN_RE.test(token)) {
      throw new Error(`ABIGAAIL_GITHUB_TOKEN_${suffix} must be a fine-grained token (github_pat_…) for that one repository, with Contents: read only`);
    }
    out.push({ app: suffix.toLowerCase().replace(/_/g, "-"), repo, token });
  }
  return out;
}

/** Removes the tokens from an environment (the server's own, once read), so nothing started later inherits them. */
export function dropGithubTokens(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) if (key.startsWith("ABIGAAIL_GITHUB_TOKEN_")) delete env[key];
}

/** The environment variable names for an app's link (for messages). */
export const githubEnvNames = (app: string) => ({ repo: `ABIGAAIL_GITHUB_REPO_${envSuffix(app)}`, token: `ABIGAAIL_GITHUB_TOKEN_${envSuffix(app)}` });

// ---- the client ---------------------------------------------------------------------

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type Answer =
  | { kind: "ok"; body: unknown }
  | { kind: "status"; status: number; rateLimited: boolean }
  | { kind: "too_large" }
  | { kind: "unreachable" };

/** One GET to api.github.com: bounded in time and size, no redirects, the token only in its header. */
export async function githubGet(fetchFn: Fetch, path: string, token: string): Promise<Answer> {
  const url = new URL(path, GITHUB.origin);
  // Exactly the path asked for (nothing a URL parser normalised away), under /repos/, on api.github.com.
  if (url.origin !== GITHUB.origin || url.pathname !== path || !path.startsWith("/repos/")) throw new RangeError("not a GitHub API path");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GITHUB.timeoutMs);
  timer.unref();
  try {
    const res = await fetchFn(url.href, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "abigaail",
      },
      redirect: "error",
      signal: ac.signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "status", status: res.status, rateLimited: res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429 };
    }
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (declared > GITHUB.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "too_large" };
    }
    const reader = res.body?.getReader();
    if (!reader) return { kind: "unreachable" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GITHUB.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
    try {
      return { kind: "ok", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
      return { kind: "status", status: 200, rateLimited: false };
    }
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

const CHANGES = new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]);
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

/**
 * Paths and hunk line ranges from a compare's `files`. The patch is read for
 * its "@@ -a,b +c,d @@" headers only and nothing else of it is kept. A path
 * that is not a plain relative path is left out.
 */
export function parseCompare(body: unknown): { files: number; truncated: boolean; hunks: CodeHunk[] } | undefined {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return undefined;
  const hunks: CodeHunk[] = [];
  let kept = 0;
  for (const f of files.slice(0, GITHUB.maxFiles) as Record<string, unknown>[]) {
    const file = f?.filename;
    if (!isRepoPath(file)) continue;
    kept++;
    const previous = isRepoPath(f.previous_filename) ? f.previous_filename : null;
    const change = typeof f.status === "string" && CHANGES.has(f.status) ? f.status : "modified";
    const ranges: [number, number][] = [];
    if (typeof f.patch === "string") {
      HUNK_RE.lastIndex = 0;
      for (let m = HUNK_RE.exec(f.patch); m && ranges.length < GITHUB.maxHunksPerFile; m = HUNK_RE.exec(f.patch)) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        // A hunk that only removes lines sits after line `start`.
        ranges.push([Math.max(1, start), Math.max(1, start + Math.max(1, count) - 1)]);
      }
    }
    if (!ranges.length) hunks.push({ file, previous_file: previous, change, start_line: null, end_line: null });
    for (const [a, b] of ranges) hunks.push({ file, previous_file: previous, change, start_line: a, end_line: b });
  }
  return { files: kept, truncated: files.length >= GITHUB.maxFiles, hunks };
}

const isRepoPath = (p: unknown): p is string =>
  isFramePath(p) && !(p as string).split("/").some((s) => s === "" || s === "." || s === "..");

// ---- the job ---------------------------------------------------------------------------

export interface CodeLinksOptions {
  store: Store;
  links: readonly CodeLinkConfig[];
  /** Tests and the simulator's fixture replace the network here; the origin is still checked. */
  fetch?: Fetch;
  now?: () => number;
  /** Fixed messages only: app names, reasons and error classes. */
  log?: (msg: string) => void;
}

/**
 * Every minute: for each linked app, the releases deployed in the last week
 * whose commit and the replaced release's commit are known get GitHub's
 * compare once (a compare of two commits never changes, so it is cached for
 * good); failures are retried with back-off. Never throws.
 */
export class CodeLinks {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** Apps whose token was refused: not asked again before this time. */
  private readonly refusedUntil = new Map<string, number>();
  private readonly logged = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly opts: CodeLinksOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((msg) => console.error(`[abigaail] ${msg}`));
  }

  start(): void {
    const tick = () => void this.runOnce();
    setTimeout(tick, 5_000).unref();
    this.timer = setInterval(tick, GITHUB.everyMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One pass over every link; a pass still running is waited for, not overlapped. */
  runOnce(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  private once(key: string, msg: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(msg);
  }

  private async pass(): Promise<void> {
    const ids: string[] = [];
    for (const link of this.opts.links) {
      try {
        const app = this.opts.store.appByName(link.app);
        if (!app) {
          this.once(`noapp:${link.app}`, `github: no app named ${link.app}; its link waits until it exists`);
          continue;
        }
        ids.push(app.id);
        if (app.disabled_at !== null) continue;
        await this.app(app.id, link);
        this.opts.store.pruneCodeDiffs(app.id, this.now() - GITHUB.keepMs);
      } catch (err) {
        this.log(`github: ${link.app}: failed (${errorClass(err)})`);
      }
    }
    try {
      this.opts.store.removeCodeLinks(ids);
    } catch (err) {
      this.log(`github: could not forget removed links (${errorClass(err)})`);
    }
  }

  private async app(appId: string, link: CodeLinkConfig): Promise<void> {
    const store = this.opts.store;
    const now = this.now();
    if ((this.refusedUntil.get(appId) ?? 0) > now) return;
    const known = store.codeLink(appId);
    if (!known || known.repo !== link.repo) store.setCodeLink(appId, link.repo, "ok", null);
    else if (known.state === "failed") {
      // Refused before (or before a restart with a new token): ask once whether it works now, whatever is due.
      const repo = await githubGet(this.fetch, `/repos/${link.repo}`, link.token);
      if (repo.kind === "ok") store.setCodeLink(appId, link.repo, "ok", null);
      else if (repo.kind === "status" && repo.status === 401) return this.refused(appId, link, REASONS.revoked);
      else if (repo.kind === "status" && (repo.status === 403 || repo.status === 404) && !repo.rateLimited) return this.refused(appId, link, REASONS.noRepo);
      else return;
    }
    const deploys = store.deploys(appId);
    const due = deploys
      .filter((d) => d.commit_sha && (d.deployed_at ?? d.first_seen) >= now - GITHUB.fetchWindowMs)
      .sort((a, b) => (b.deployed_at ?? b.first_seen) - (a.deployed_at ?? a.first_seen));
    let asked = 0;
    for (const d of due) {
      if (asked >= GITHUB.perRun) break;
      const baseRelease = d.replaced_release ?? d.previous_release;
      const base = deploys.find((x) => x.release === baseRelease)?.commit_sha;
      const head = d.commit_sha!;
      if (!base || !COMMIT_RE.test(base) || !COMMIT_RE.test(head)) continue;
      const old = store.codeDiff(appId, d.release);
      const same = old && old.base_commit === base && old.head_commit === head && old.repo === link.repo;
      if (same && (old.status === "ok" || old.status === "too_large")) continue;
      if (same && (old.tries >= GITHUB.maxTries || (old.next_try_at ?? 0) > now)) continue;
      const tries = same ? old.tries + 1 : 1;
      const diff = { release: d.release, repo: link.repo, base_commit: base, head_commit: head, files: 0, truncated: 0, tries };
      const retry = (): number => now + Math.min(GITHUB.retryMaxMs, GITHUB.retryMs * 2 ** (tries - 1));
      if (base === head) {
        store.saveCodeDiff(appId, { ...diff, status: "ok", reason: null, next_try_at: null }, []);
        continue;
      }
      asked++;
      const a = await githubGet(this.fetch, `/repos/${link.repo}/compare/${base}...${head}`, link.token);
      if (a.kind === "ok") {
        const parsed = parseCompare(a.body);
        if (!parsed) {
          store.saveCodeDiff(appId, { ...diff, status: "failed", reason: REASONS.badAnswer, next_try_at: retry() }, []);
          continue;
        }
        store.setCodeLink(appId, link.repo, "ok", null);
        store.saveCodeDiff(appId, { ...diff, status: "ok", reason: null, files: parsed.files, truncated: parsed.truncated ? 1 : 0, next_try_at: null }, parsed.hunks);
        continue;
      }
      if (a.kind === "too_large") {
        store.saveCodeDiff(appId, { ...diff, status: "too_large", reason: REASONS.tooLarge, next_try_at: null }, []);
        continue;
      }
      if (a.kind === "unreachable" || a.status >= 500 || a.status === 200 || a.rateLimited) {
        const reason = a.kind === "status" && a.rateLimited ? REASONS.rateLimited : a.kind === "status" && a.status === 200 ? REASONS.badAnswer : REASONS.unreachable;
        store.saveCodeDiff(appId, { ...diff, status: "failed", reason, next_try_at: retry() }, []);
        // The rest of this app's releases wait for the next pass.
        return;
      }
      if (a.status === 401) return this.refused(appId, link, REASONS.revoked);
      if (a.status === 403) return this.refused(appId, link, REASONS.forbidden);
      if (a.status === 404 || a.status === 422) {
        // The repository the token cannot see, or a commit that is not there.
        const repo = await githubGet(this.fetch, `/repos/${link.repo}`, link.token);
        if (repo.kind === "status" && (repo.status === 404 || repo.status === 403 || repo.status === 401)) {
          return this.refused(appId, link, repo.status === 401 ? REASONS.revoked : REASONS.noRepo);
        }
        if (repo.kind === "ok") store.setCodeLink(appId, link.repo, "ok", null);
        store.saveCodeDiff(appId, { ...diff, status: "not_found", reason: REASONS.noCommit, next_try_at: retry() }, []);
        continue;
      }
      store.saveCodeDiff(appId, { ...diff, status: "failed", reason: REASONS.badAnswer, next_try_at: retry() }, []);
    }
  }

  private refused(appId: string, link: CodeLinkConfig, reason: string): void {
    this.refusedUntil.set(appId, this.now() + GITHUB.refusedRetryMs);
    this.opts.store.setCodeLink(appId, link.repo, "failed", reason);
    this.once(`refused:${link.app}:${reason}`, `github: ${link.app}: ${reason} (${githubEnvNames(link.app).token})`);
  }
}

