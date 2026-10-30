// Opt-in source maps (DECISIONS #136): frames in compiled files (dist/,
// .next/, build/) are mapped to the source file and line with Node's own
// `module.SourceMap`, before they are sent. Without it they name compiled
// lines, and a diff cannot be matched to them.
//
// Off by default (`sourceMaps: true` or ABIGAAIL_SOURCE_MAPS=1; `off` always
// wins), because it reads files in the host app. Budgets: a map is read only
// for a compiled frame of the app's own code, at most `maxMapBytes`, never
// more than one at a time and asynchronously; at most `maxMaps` stay in memory,
// without their `sourcesContent` (the code is never kept); parsing one over
// `parseBudgetMs` is an overrun, and after `maxOverruns` mapping is off for
// the process. A mapped path follows the stack-frame rules: project-relative
// or the compiled frame is kept as it was. Never throws.

import { open, readFile, stat } from "node:fs/promises";
import { SourceMap } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isFramePath, type StackFrame } from "@abigaail/schema";
import { relativePath } from "./stack.js";

export const SOURCE_MAPS = {
  maxMapBytes: 16 * 1024 * 1024,
  maxMaps: 64,
  /** JSON.parse plus SourceMap's own parse of one map, on the main thread. */
  parseBudgetMs: 100,
  maxOverruns: 3,
  /** An error waits at most this long for its maps, then is sent as it is. */
  waitMs: 2_000,
  /** The end of a compiled file read for its sourceMappingURL comment. */
  tailBytes: 512,
} as const;

type Limits = Record<keyof typeof SOURCE_MAPS, number>;

/** Compiled output a stack frame can point at (the dashboard's hint uses the same list). */
export const COMPILED_RE = /^(?:dist|build|out|\.next|\.output)\//;
const SCRIPT_RE = /\.(?:c|m)?js$/;
const URL_COMMENT_RE = /[#@] sourceMappingURL=([^\s'"]+)\s*$/;

/** Opt-in; ABIGAAIL_SOURCE_MAPS=off, 0 or false always wins. */
export function sourceMapsWanted(option: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  const v = env.ABIGAAIL_SOURCE_MAPS?.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  return option ?? (v === "1" || v === "on" || v === "true");
}

interface Loaded {
  map: SourceMap;
  /** Absolute directory of the map, and its sourceRoot: relative sources resolve against both. */
  dir: string;
  sourceRoot: string;
}

export interface MapperOptions {
  /** Tests: other limits. */
  limits?: Partial<Limits>;
  /** Tests: the clock that times a parse. */
  now?: () => number;
}

export class SourceMapper {
  /** Per project-relative compiled file: its map, or null when it has none (or it could not be used). */
  private readonly cache = new Map<string, Loaded | null>();
  private readonly limits: Limits;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private overruns = 0;
  private off = false;
  private hinted = false;

  constructor(
    private readonly root: string,
    private readonly warn: (msg: string) => void,
    opts: MapperOptions = {},
  ) {
    this.limits = { ...SOURCE_MAPS, ...opts.limits };
    this.now = opts.now ?? (() => performance.now());
  }

  /** Whether a frame's file can have a map: the app's own compiled script, not a dependency. */
  private wants(file: string): boolean {
    return SCRIPT_RE.test(file) && !file.startsWith("(") && !file.includes("node_modules/") && !file.split("/").includes("..");
  }

  /** Files of these frames whose maps are not known yet. */
  missing(files: readonly string[]): string[] {
    if (this.off) return [];
    return [...new Set(files)].filter((f) => this.wants(f) && !this.cache.has(f));
  }

  /** Loads the maps these files need, one at a time; resolves when done or after waitMs. Never rejects. */
  load(files: readonly string[]): Promise<void> {
    const todo = this.missing(files);
    if (!todo.length) return Promise.resolve();
    const work = (this.queue = this.queue.then(async () => {
      for (const f of todo) {
        if (this.off || this.cache.has(f)) continue;
        this.remember(f, await this.read(f).catch(() => null));
      }
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((r) => {
      timer = setTimeout(r, this.limits.waitMs);
      timer.unref();
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  private remember(file: string, entry: Loaded | null): void {
    this.cache.set(file, entry);
    // Oldest out first; a file seen again later is read again.
    while (this.cache.size > this.limits.maxMaps) this.cache.delete(this.cache.keys().next().value!);
  }

  /** The map for a compiled file: its sourceMappingURL comment (a file next to it), else `<file>.map`. */
  private async read(file: string): Promise<Loaded | null> {
    const abs = join(this.root, file);
    let mapPath = `${abs}.map`;
    const fh = await open(abs, "r");
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, this.limits.tailBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const url = URL_COMMENT_RE.exec(buf.toString("utf8"))?.[1];
      if (url?.startsWith("data:")) return null;
      if (url && !/^[a-z]+:/i.test(url) && !isAbsolute(url)) mapPath = resolve(dirname(abs), decodeURIComponent(url));
    } finally {
      await fh.close();
    }
    // The map must be inside the project too.
    if (relativePath(mapPath, this.root) === undefined) return null;
    const st = await stat(mapPath).catch(() => undefined);
    if (!st?.isFile()) return null;
    if (st.size > this.limits.maxMapBytes) return null;
    const text = await readFile(mapPath, "utf8");
    if (this.off) return null;
    const t0 = this.now();
    let loaded: Loaded | null = null;
    try {
      const payload = JSON.parse(text) as { sourcesContent?: unknown; sourceRoot?: unknown; sections?: unknown };
      // The code itself is never kept.
      delete payload.sourcesContent;
      if (!payload.sections) {
        const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot : "";
        loaded = { map: new SourceMap(payload as ConstructorParameters<typeof SourceMap>[0]), dir: dirname(mapPath), sourceRoot };
      }
    } catch {
      loaded = null;
    }
    if (this.now() - t0 > this.limits.parseBudgetMs && ++this.overruns >= this.limits.maxOverruns) {
      this.off = true;
      this.cache.clear();
      this.warn(`source maps took over ${this.limits.parseBudgetMs} ms to read ${this.limits.maxOverruns} times; mapping is off for this process`);
      return null;
    }
    return loaded;
  }

  /** A source position (0-based line and column of a compiled file) as a project-relative source path and 1-based line, or undefined. */
  position(file: string, line0: number, col0: number): { file: string; line: number; col: number } | undefined {
    const m = this.off ? undefined : this.cache.get(file);
    if (!m || line0 < 0 || col0 < 0) return undefined;
    try {
      const e = m.map.findEntry(line0, col0) as { generatedLine?: number; originalSource?: string; originalLine?: number; originalColumn?: number };
      if (e.generatedLine !== line0 || typeof e.originalSource !== "string" || !Number.isInteger(e.originalLine)) return undefined;
      const source = this.sourcePath(e.originalSource, m);
      if (!source) return undefined;
      return { file: source, line: e.originalLine! + 1, col: (e.originalColumn ?? 0) + 1 };
    } catch {
      return undefined;
    }
  }

  /**
   * A map's source as a project-relative path, under the stack-frame rules:
   * bundler URLs (webpack://, turbopack://) are project-relative already;
   * files resolve against the map's directory and sourceRoot. Anything outside
   * the project, or not a plain path, is no answer.
   */
  private sourcePath(source: string, m: Loaded): string | undefined {
    let s = source;
    let out: string | undefined;
    if (s.startsWith("webpack://")) {
      out = s.replace(/^webpack:\/\/[^/]*\//, "").replace(/^(?:\.\/)+/, "");
    } else if (s.startsWith("turbopack://")) {
      s = s.replace(/^turbopack:\/\/\/?\[project\]\//, "");
      out = s.startsWith("turbopack:") ? undefined : s;
    } else if (s.startsWith("file://")) {
      out = relativePath(s, this.root);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      out = undefined;
    } else {
      out = relativePath(resolve(m.dir, m.sourceRoot, s), this.root);
    }
    if (!out || !isFramePath(out) || out.split("/").some((p) => p === "" || p === "." || p === "..")) return undefined;
    return out;
  }

  /** Frames with the maps already loaded (synchronous): a frame without a usable map is kept as it was. */
  mapFrames(frames: readonly StackFrame[]): StackFrame[] {
    let unmapped = false;
    const out = frames.map((f) => {
      if (!this.wants(f.file)) return f;
      const p = f.col !== undefined ? this.position(f.file, f.line - 1, f.col - 1) : undefined;
      if (!p) {
        if (COMPILED_RE.test(f.file) && this.cache.get(f.file) === null) unmapped = true;
        return f;
      }
      return { ...f, file: p.file, line: p.line, col: p.col };
    });
    if (unmapped) this.hint();
    return out;
  }

  private hint(): void {
    if (this.hinted || this.off) return;
    this.hinted = true;
    this.warn(
      "stack frames point at compiled files (dist/, .next/, build/) and no source map was found next to them; build with source maps (README, \"Source maps\")",
    );
  }
}

/**
 * Without mapping: once, when the first frames point at compiled files, say
 * how to have them name source lines (no file is read to find this out).
 */
export function compiledHint(frames: readonly StackFrame[] | undefined): boolean {
  return !!frames?.some((f) => COMPILED_RE.test(f.file));
}
