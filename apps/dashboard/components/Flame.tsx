import type { FlameNode } from "@abigaail/insights";

const W = 1040;
const ROW = 18;
const MAX_DEPTH = 24;
/** Narrower boxes are drawn without a label. */
const LABEL_MIN_PX = 60;

interface Box {
  x: number;
  w: number;
  depth: number;
  node: FlameNode;
}

function layout(root: FlameNode): Box[] {
  const out: Box[] = [];
  const walk = (n: FlameNode, x: number, w: number, depth: number) => {
    if (depth > 0) out.push({ x, w, depth: depth - 1, node: n });
    if (depth >= MAX_DEPTH) return;
    let cx = x;
    for (const c of n.children) {
      const cw = (c.value / n.value) * w;
      walk(c, cx, cw, depth + 1);
      cx += cw;
    }
  };
  if (root.value > 0) walk(root, 0, W, 0);
  return out;
}

/**
 * An icicle (a flame graph from the top): each box is a function, its width
 * its share of the samples, its children what it called. Server-rendered SVG;
 * hovering a box shows its title, and the table beside it carries the numbers.
 */
export function Flame({ root, unit }: { root: FlameNode; unit: "samples" | "bytes" }) {
  const boxes = layout(root);
  const depth = Math.max(1, ...boxes.map((b) => b.depth + 1));
  const H = depth * ROW;
  const share = (v: number) => `${((v / root.value) * 100).toFixed(v / root.value < 0.1 ? 1 : 0)}%`;
  return (
    <div className="chartscroll">
      <svg className="flame" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Flame graph of ${root.value} ${unit}, outermost function at the top`}>
        {boxes.map((b, i) => {
          const placeholder = b.node.frame?.file.startsWith("(") ?? false;
          return (
            <g key={i}>
              <rect className={placeholder ? "fbox other" : "fbox"} x={b.x + 0.5} y={b.depth * ROW + 0.5} width={Math.max(0.5, b.w - 1)} height={ROW - 1}>
                <title>{`${b.node.label}: ${share(b.node.value)} (${b.node.value.toLocaleString("en-GB")} ${unit})`}</title>
              </rect>
              {b.w >= LABEL_MIN_PX ? (
                <text className="flabel" x={b.x + 4} y={b.depth * ROW + 13}>
                  {b.node.label.length * 6.5 > b.w - 8 ? `${b.node.label.slice(0, Math.max(1, Math.floor((b.w - 14) / 6.5)))}…` : b.node.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
