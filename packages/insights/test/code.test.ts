// Diff → file/line (DECISIONS #138): which frames sit in code a release changed.

import { describe, expect, it } from "vitest";
import { codeUrl, involved, involvedText, type CodeContext } from "@abigaail/insights";
import type { CodeHunk } from "@abigaail/store";

const HEAD = "2222222222222222222222222222222222222222";
const hunk = (file: string, start: number | null, end: number | null, change = "modified"): CodeHunk => ({ file, previous_file: null, change, start_line: start, end_line: end });
const ctx = (hunks: CodeHunk[]): CodeContext => ({
  status: "ok",
  link: { repo: "owner/shop", state: "ok", reason: null, checked_at: 0, since: 0 },
  diff: { release: "r2", repo: "owner/shop", base_commit: "1".repeat(40), head_commit: HEAD, status: "ok", reason: null, files: hunks.length, truncated: 0, fetched_at: 0, tries: 1, next_try_at: null },
  hunks,
});

describe("involved", () => {
  const c = ctx([hunk("src/checkout.ts", 10, 15), hunk("src/checkout.ts", 80, 80), hunk("apps/web/src/page.tsx", 5, 6), hunk("assets/x.bin", null, null), hunk("src/gone.ts", 1, 9, "removed")]);

  it("inside a hunk, or within 3 lines of it, is a line match; elsewhere in a changed file is a file match", () => {
    const got = involved(c, [
      { file: "src/checkout.ts", line: 40, what: "far" },
      { file: "src/checkout.ts", line: 12, fn: "applyDiscount", what: "inside" },
      { file: "src/checkout.ts", line: 18, what: "3 below" },
      { file: "src/checkout.ts", line: 19, what: "4 below" },
      { file: "src/checkout.ts", line: 7, what: "3 above" },
    ]);
    expect(got.map((g) => [g.line, g.match, g.lines])).toEqual([[12, "line", [10, 15]], [18, "line", [10, 15]], [7, "line", [10, 15]], [40, "file", null], [19, "file", null]]);
    expect(got[0]).toMatchObject({ fn: "applyDiscount", what: "inside", url: `https://github.com/owner/shop/blob/${HEAD}/src/checkout.ts#L10-L15` });
    expect(got[3]!.url).toBe(`https://github.com/owner/shop/blob/${HEAD}/src/checkout.ts#L40`);
  });

  it("an app in a subdirectory of the repository matches by path suffix", () => {
    expect(involved(c, [{ file: "src/page.tsx", line: 5, what: "x" }])).toMatchObject([{ match: "line", url: `https://github.com/owner/shop/blob/${HEAD}/apps/web/src/page.tsx#L5-L6` }]);
    // ...at a path boundary only.
    expect(involved(c, [{ file: "rc/page.tsx", line: 5, what: "x" }])).toEqual([]);
  });

  it("never matches dependencies, placeholders, removed files, or a file GitHub sent no lines for beyond 'file'", () => {
    expect(involved(c, [
      { file: "node_modules/lib/src/checkout.ts", line: 12, what: "dep" },
      { file: "(native)", line: 0, what: "native" },
      { file: "src/gone.ts", line: 3, what: "removed" },
    ])).toEqual([]);
    expect(involved(c, [{ file: "assets/x.bin", line: 3, what: "bin" }])).toMatchObject([{ match: "file", lines: null }]);
  });

  it("nothing without a fetched diff", () => {
    expect(involved({ ...c, status: "failed" }, [{ file: "src/checkout.ts", line: 12, what: "x" }])).toEqual([]);
  });

  it("in words: line matches only", () => {
    const got = involved(c, [{ file: "src/checkout.ts", line: 12, fn: "applyDiscount", what: "x" }, { file: "src/checkout.ts", line: 40, what: "y" }]);
    expect(involvedText(got, "r2")).toBe("Changed code involved: src/checkout.ts:12 (applyDiscount), lines 10-15, changed in r2.");
    expect(involvedText(got.filter((g) => g.match === "file"), "r2")).toBe("");
  });
});

describe("codeUrl", () => {
  it("only ever https://github.com, from checked parts, with the path encoded", () => {
    expect(codeUrl("owner/shop", HEAD, "src/a b#c.ts", [3, 3])).toBe(`https://github.com/owner/shop/blob/${HEAD}/src/a%20b%23c.ts#L3`);
    expect(codeUrl("evil.example/x/y", HEAD, "a.ts", [1, 2])).toBeUndefined();
    expect(codeUrl("owner/shop", "main", "a.ts", [1, 2])).toBeUndefined();
  });
});
