import type { StackFrame } from "@abigaail/schema";

// Error details that may leave the app: the class name, project-relative
// frames, and the raw message, code and cause for the core sanitiser, which
// keeps codes only by pattern and sends a message only after the shared
// scrubber (DECISIONS #101). Never absolute paths (they leak usernames and hosts).

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

/**
 * An own data property, read without running any getter: a throwing or slow
 * getter, or a Proxy, cannot affect the host app.
 */
function own(o: unknown, key: string): unknown {
  try {
    if (!o || (typeof o !== "object" && typeof o !== "function")) return undefined;
    const d = Object.getOwnPropertyDescriptor(o, key);
    return d && "value" in d ? d.value : undefined;
  } catch {
    return undefined;
  }
}

export interface ErrorDetail {
  message?: string;
  code?: unknown;
  cause_type?: string;
  cause_code?: unknown;
  cause_message?: string;
}

/**
 * Raw message, code and one level of cause. Unscrubbed: the core sanitiser
 * scrubs them before anything is queued. A thrown string is its own message;
 * other non-Error values give nothing.
 */
export function errorDetail(err: unknown): ErrorDetail {
  try {
    if (typeof err === "string") return { message: err.slice(0, 2048) };
    if (!(err instanceof Error)) return {};
    const out: ErrorDetail = {};
    const message = own(err, "message");
    if (typeof message === "string") out.message = message.slice(0, 2048);
    const code = own(err, "code");
    if (typeof code === "string" || typeof code === "number") out.code = code;
    const cause = own(err, "cause");
    if (cause instanceof Error) {
      out.cause_type = errorType(cause);
      const cm = own(cause, "message");
      if (typeof cm === "string") out.cause_message = cm.slice(0, 2048);
      const cc = own(cause, "code");
      if (typeof cc === "string" || typeof cc === "number") out.cause_code = cc;
    }
    return out;
  } catch {
    return {};
  }
}

/** A failed outbound call's error code (own `code`, or its cause's): kept only if it matches a code pattern later. */
export function errorCodeOf(err: unknown): string | undefined {
  const code = own(err, "code") ?? own(own(err, "cause"), "code");
  return typeof code === "string" ? code : undefined;
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
