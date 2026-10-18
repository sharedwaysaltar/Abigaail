"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface ChartPoint {
  hour: number;
  p95: number | null;
  state: "ok" | "few" | "no-data" | "building";
  requests: number;
  band: { lo: number; mid: number; hi: number } | null;
}

const W = 1040;
const H = 260;
// Tick labels sit above their gridlines at the right edge, so they stay in view when the chart scrolls.
const PAD = { l: 8, r: 8, t: 24, b: 32 };

const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : `${Math.round(v)} ms`);
const hh = (ts: number) => `${String(new Date(ts).getUTCHours()).padStart(2, "0")}:00`;
const STATE_TEXT = { "no-data": "no data (the app sent nothing)", few: "too few requests", building: "still being rolled up" } as const;

/** Nice round ticks from 0 to at least max. */
function ticks(max: number): number[] {
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return [0, step, 2 * step, 3 * step];
}

/**
 * One series (hourly p95) against its normal band. Gaps where there is no
 * data are shaded, never drawn as zero. Hover shows the hour; the table below
 * carries every value.
 */
export function ResponseChart({ points }: { points: ChartPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // On a narrow screen the chart scrolls; start at "now", on the right.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  const titleId = useId();
  const n = points.length;
  const max = Math.max(1, ...points.flatMap((p) => [p.p95 ?? 0, p.band?.hi ?? 0]));
  const yt = ticks(max);
  const top = yt[yt.length - 1]!;
  const x = (i: number) => PAD.l + ((i + 0.5) * (W - PAD.l - PAD.r)) / n;
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const cell = (W - PAD.l - PAD.r) / n;

  // Line segments over consecutive hours with a value.
  const segments: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.p95 === null) {
      if (cur.length) segments.push(cur.join(" "));
      cur = [];
    } else cur.push(`${cur.length ? "L" : "M"}${x(i).toFixed(1)},${y(p.p95).toFixed(1)}`);
  });
  if (cur.length) segments.push(cur.join(" "));
  // Single isolated points get a dot so they are not invisible.
  const lone = points.map((p, i) => ({ p, i })).filter(({ p, i }) => p.p95 !== null && points[i - 1]?.p95 == null && points[i + 1]?.p95 == null);

  // Band as runs of consecutive hours that have one.
  const bands: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const up = run.map((i) => `${x(i) - (run.length === 1 ? cell / 3 : 0)},${y(points[i]!.band!.hi)}`);
    const down = [...run].reverse().map((i) => `${x(i) + (run.length === 1 ? cell / 3 : 0)},${y(points[i]!.band!.lo)}`);
    bands.push(`M${up.join(" L")} L${down.join(" L")} Z`);
    run = [];
  };
  points.forEach((p, i) => (p.band ? run.push(i) : flush()));
  flush();

  const last = [...points].map((p, i) => ({ p, i })).reverse().find(({ p }) => p.p95 !== null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const vx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round((vx - PAD.l) / cell - 0.5);
    setHover(i >= 0 && i < n ? i : null);
  };
  const hp = hover === null ? undefined : points[hover];

  return (
    <div className="chartscroll" ref={scroller}>
    <div className="chartbox">
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <title id={titleId}>{`Response time p95 per hour over the last ${n} hours, against its normal band`}</title>
        {points.map((p, i) =>
          p.state === "ok" ? null : <rect key={`g${i}`} className="gap" x={x(i) - cell / 2} y={PAD.t} width={cell} height={H - PAD.t - PAD.b} />,
        )}
        {yt.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            {t > 0 ? <text className="axis" x={W - PAD.r} y={y(t) - 6} textAnchor="end">{fmtMs(t)}</text> : null}
          </g>
        ))}
        {points.map((p, i) =>
          i % 6 === 0 ? <text key={`x${i}`} className="axis" x={x(i)} y={H - 8} textAnchor="middle">{hh(p.hour)}</text> : null,
        )}
        {bands.map((d, i) => <path key={`b${i}`} className="band" d={d} />)}
        {segments.map((d, i) => <path key={`s${i}`} className="series" d={d} />)}
        {lone.map(({ p, i }) => <circle key={`l${i}`} className="end" cx={x(i)} cy={y(p.p95!)} r={4} />)}
        {points.map((p, i) =>
          p.p95 !== null && p.band && p.p95 > p.band.hi ? <circle key={`a${i}`} className="above" cx={x(i)} cy={y(p.p95)} r={4} /> : null,
        )}
        {last && !(last.p.band && last.p.p95! > last.p.band.hi) ? <circle className="end" cx={x(last.i)} cy={y(last.p.p95!)} r={4} /> : null}
        {hp ? (
          <g>
            <line className="cross" x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={H - PAD.b} />
            {hp.p95 !== null ? <circle className="hover-dot" cx={x(hover!)} cy={y(hp.p95)} r={5} /> : null}
          </g>
        ) : null}
        {/* Hit area wider than the marks. */}
        <rect x={PAD.l} y={0} width={W - PAD.l - PAD.r} height={H} fill="transparent" />
      </svg>
      {hp ? (
        <div className={`tip${x(hover!) > W * 0.6 ? " left" : ""}`} style={{ left: `${(x(hover!) / W) * 100}%` }}>
          <b>{hh(hp.hour)}–{hh(hp.hour + 3_600_000)} UTC</b>
          <br />
          {hp.p95 !== null ? `p95 ${fmtMs(hp.p95)}` : STATE_TEXT[hp.state as keyof typeof STATE_TEXT]}
          {hp.band ? <><br /><span className="muted">usual {fmtMs(hp.band.mid)} (normal {fmtMs(hp.band.lo)}–{fmtMs(hp.band.hi)})</span></> : <><br /><span className="muted">no baseline for this hour yet</span></>}
          {hp.requests ? <><br /><span className="muted">{hp.requests.toLocaleString("en-GB")} requests</span></> : null}
        </div>
      ) : null}
    </div>
    </div>
  );
}
