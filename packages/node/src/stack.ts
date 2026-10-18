import type { StackFrame } from "@abigaail/schema";

// Error details that may leave the app: the class name and project-relative
// frames. Never the message, never absolute paths (they leak usernames and hosts).

const MAX_LINE = 500;
const MAX_LINES = 50;

/** Class name of a thrown value. Not validated here; the core sanitiser maps bad names to "Error". */
export function errorType(err: unknown): string {
  try {
    if (err instanceof Error) {
      const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
      if (typeof ctor === "string" && ctor && ctor !== "Error") return ctor;
      return typeof err.name === "string" && err.name ? err.name : "Error";
    }
    return "NonError";
  } catch {
    return "Error";
  }
}

/** Turn a stack location into a project-relative path, or undefined to drop the frame. */
export function relativePath(location: string, root: string): string | undefined {
  let file = location;
  if (file.startsWith("node:") || !file) return undefined;
  if (file.startsWith("webpack-internal:///")) {
    // Next dev bundles: "webpack-internal:///(rsc)/./src/app/page.tsx".
    file = file.slice("webpack-internal:///".length).replace(/^\([^)/]*\)\//, "").replace(/^\.\//, "");
    return file;
  }
  if (file.startsWith("file://")) {
    try {
      file = decodeURIComponent(new URL(file).pathname);
    } catch {
      return undefined;
    }
  }
  file = file.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  if (file.startsWith(base)) return file.slice(base.length);
  // Absolute path outside the project, or a URL: drop it.
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file) || file.includes("://")) return undefined;
  return file;
}

/** Parse one V8 stack line ("    at fn (file:line:col)" or "    at file:line:col"). */
function parseLine(line: string, root: string): StackFrame | undefined {
  let s = line.trim();
  if (!s.startsWith("at ")) return undefined;
  s = s.slice(3);
  let fn: string | undefined;
  let loc = s;
  if (s.endsWith(")")) {
    const open = s.lastIndexOf(" (");
    if (open === -1) return undefined;
    fn = s.slice(0, open).replace(/^(async|new) /, "");
    loc = s.slice(open + 2, -1);
  }
  const c2 = loc.lastIndexOf(":");
  const c1 = c2 === -1 ? -1 : loc.lastIndexOf(":", c2 - 1);
  if (c1 === -1) return undefined;
  const lineNo = Number(loc.slice(c1 + 1, c2));
  const col = Number(loc.slice(c2 + 1));
  if (!Number.isInteger(lineNo) || !Number.isInteger(col)) return undefined;
  const file = relativePath(loc.slice(0, c1), root);
  if (!file) return undefined;
  const frame: StackFrame = { file, line: lineNo, col };
  if (fn) frame.fn = fn;
  return frame;
}

/** Frames from `err.stack`, project-relative only. The message lines are skipped. */
export function parseStack(err: unknown, root: string): StackFrame[] | undefined {
  try {
    const stack = err instanceof Error ? err.stack : undefined;
    if (typeof stack !== "string") return undefined;
    const frames: StackFrame[] = [];
    for (const line of stack.split("\n", 200)) {
      if (frames.length >= MAX_LINES) break;
      // The message comes first and can span lines; only "at" lines are frames.
      if (line.length > MAX_LINE) continue;
      const f = parseLine(line, root);
      if (f) frames.push(f);
    }
    return frames.length ? frames : undefined;
  } catch {
    return undefined;
  }
}
