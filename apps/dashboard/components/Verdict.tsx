import type { Verdict } from "@abigaail/insights";

/** Rollout Safety's verdicts in words (DECISIONS #131). */
export const VERDICT_LABEL: Record<Verdict, string> = {
  rollback: "Recommend rollback",
  watch: "Watch",
  fine: "Looks fine",
  too_little: "Too little traffic yet",
};

/** Shown once on the Releases pages while frames point at compiled output (DECISIONS #135). */
export function SourceMapHint() {
  return (
    <p className="small muted" style={{ marginTop: 16 }}>
      Stack frames on this release point at compiled files (<span className="mono">dist/</span>, <span className="mono">.next/</span>,{" "}
      <span className="mono">build/</span>), so findings name compiled lines rather than your source, and changed code cannot be
      matched to them. Emit source maps when you build and start the app with{" "}
      <span className="mono">ABIGAAIL_SOURCE_MAPS=1</span> (README: Source maps): the SDK then names the source files and lines.
    </p>
  );
}
