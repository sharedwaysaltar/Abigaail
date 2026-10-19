import type { AgentRun } from "@abigaail/store";
import { ms, when } from "@/lib/format";

const W = 6;
const GAP = 3;
const H = 22;

/**
 * The last runs, oldest left. An ok run is a grey bar as tall as its share of
 * the timeout (at least a sliver); error and timeout are full red bars; a
 * skipped run is a ring. Each bar has a title; a table repeats it in words.
 */
export function RunStrip({ runs, timeoutMs }: { runs: AgentRun[]; timeoutMs?: number }) {
  const list = [...runs].reverse();
  const failed = list.filter((r) => r.outcome === "error" || r.outcome === "timeout").length;
  const label = `${list.length} recent runs, ${failed} failed`;
  return (
    <svg className="runstrip" width={list.length * (W + GAP)} height={H} viewBox={`0 0 ${Math.max(1, list.length * (W + GAP))} ${H}`} role="img" aria-label={label}>
      {list.map((r, i) => {
        const x = i * (W + GAP);
        const title = `${when(r.started_at)}: ${r.outcome}${r.outcome === "ok" ? `, ${ms(r.duration_ms)}` : r.error_class ? ` (${r.error_class})` : ""}`;
        if (r.outcome === "skipped") {
          return (
            <circle key={r.id} cx={x + W / 2} cy={H - W / 2 - 1} r={W / 2 - 1} className="run-skipped">
              <title>{title}</title>
            </circle>
          );
        }
        const bad = r.outcome !== "ok";
        const share = bad || !timeoutMs ? 1 : Math.min(1, r.duration_ms / timeoutMs);
        const h = bad ? H : Math.max(3, Math.round(share * H));
        return (
          <rect key={r.id} x={x} y={H - h} width={W} height={h} rx={1} className={bad ? "run-bad" : "run-ok"}>
            <title>{title}</title>
          </rect>
        );
      })}
    </svg>
  );
}
