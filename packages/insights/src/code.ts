// Code-aware findings (DECISIONS #136-#138): which of the frames behind a
// finding sit in code the release changed. The server's GitHub job stores, per
// release, the changed files and each hunk's line range on the new side (never
// the patch); this matches frames (errors, block functions, heap sites, a
// crash's frame) against them, for the agents and the Releases view alike.
// Paths, line ranges and links only, never code.

import type { CodeDiff, CodeHunk, CodeLink, StoreReader } from "@abigaail/store";
import { CODE } from "./thresholds.js";

export interface CodeFrame {
  file: string;
  line: number;
  fn?: string | null;
  /** What the frame stands for, in words ("TypeError on /checkout", "event-loop blocks"). */
  what: string;
}

export interface Involved {
  file: string;
  line: number;
  fn: string | null;
  what: string;
  /** "line": inside a changed hunk (± CODE.lineSlack); "file": the file changed elsewhere, or GitHub sent no lines. */
  match: "line" | "file";
  /** The hunk's new-side lines, for a line match. */
  lines: [number, number] | null;
  /** github.com link to those lines at the release's commit. */
  url: string;
}

/** Whether the release's diff is known, and if not, why (shown as it is). */
export type CodeStatus = "off" | "no_commit" | "pending" | CodeDiff["status"];

export interface CodeContext {
  status: CodeStatus;
  link: CodeLink | null;
  diff: CodeDiff | null;
  hunks: CodeHunk[];
}

const STATUS_TEXT: Record<CodeStatus, string> = {
  off: "no GitHub link is set up for this app",
  no_commit: "the deploy step sent no commit for this release or the one it replaced",
  pending: "the diff has not been fetched yet",
  ok: "",
  failed: "GitHub could not be asked",
  too_large: "the diff is too large to fetch",
  not_found: "a commit is not on GitHub",
};

export function codeStatusText(c: CodeContext): string {
  if (c.status === "failed" && c.diff?.reason) return c.diff.reason;
  return STATUS_TEXT[c.status];
}

export function codeContext(store: StoreReader, appId: string, release: string): CodeContext {
  const link = store.codeLink(appId) ?? null;
  const diff = store.codeDiff(appId, release) ?? null;
  if (diff) return { status: diff.status, link, diff, hunks: diff.status === "ok" ? store.codeHunks(appId, release) : [] };
  if (!link) return { status: "off", link, diff, hunks: [] };
  const deploys = store.deploys(appId);
  const d = deploys.find((x) => x.release === release);
  const base = d?.replaced_release ?? d?.previous_release;
  const baseCommit = deploys.find((x) => x.release === base)?.commit_sha;
  return { status: d?.commit_sha && baseCommit ? "pending" : "no_commit", link, diff, hunks: [] };
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** A link to lines of a file at a commit: only ever https://github.com, every part checked. */
export function codeUrl(repo: string, commit: string, file: string, lines: [number, number]): string | undefined {
  if (!REPO_RE.test(repo) || !SHA_RE.test(commit)) return undefined;
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${commit}/${path}#L${lines[0]}${lines[1] !== lines[0] ? `-L${lines[1]}` : ""}`;
}

/** The repository path a project-relative frame path names: the same, or the app in a subdirectory of the repo. */
const samePath = (repoPath: string, frame: string) => repoPath === frame || repoPath.endsWith(`/${frame}`);

/**
 * The frames that sit in code this release changed, line matches first, in
 * the order given (callers pass the most relevant frames first). Frames of
 * dependencies and placeholders are never matched.
 */
export function involved(c: CodeContext, frames: readonly CodeFrame[]): Involved[] {
  if (c.status !== "ok" || !c.diff) return [];
  const out: Involved[] = [];
  const seen = new Set<string>();
  for (const f of frames) {
    if (!f.file || f.file.startsWith("(") || f.file.includes("node_modules/") || !(f.line > 0)) continue;
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) continue;
    const hunks = c.hunks.filter((h) => h.change !== "removed" && samePath(h.file, f.file));
    if (!hunks.length) continue;
    const hit = hunks.find((h) => h.start_line !== null && h.end_line !== null && f.line >= h.start_line - CODE.lineSlack && f.line <= h.end_line + CODE.lineSlack);
    const lines: [number, number] | null = hit ? [hit.start_line!, hit.end_line!] : null;
    const url = codeUrl(c.diff.repo, c.diff.head_commit, hunks[0]!.file, lines ?? [f.line, f.line]);
    if (!url) continue;
    seen.add(key);
    out.push({ file: f.file, line: f.line, fn: f.fn ?? null, what: f.what, match: hit ? "line" : "file", lines, url });
  }
  return out.sort((a, b) => (a.match === b.match ? 0 : a.match === "line" ? -1 : 1)).slice(0, CODE.maxInvolved);
}

/** For a summary: the changed lines involved, in words ("" when none). */
export function involvedText(inv: readonly Involved[], release: string): string {
  const lines = inv.filter((i) => i.match === "line").slice(0, CODE.maxInSummary);
  if (!lines.length) return "";
  const said = lines.map((i) => `${i.file}:${i.line}${i.fn ? ` (${i.fn})` : ""}${i.lines ? `, lines ${i.lines[0]}-${i.lines[1]}` : ""}`);
  return `Changed code involved: ${said.join("; ")}, changed in ${release}.`;
}
