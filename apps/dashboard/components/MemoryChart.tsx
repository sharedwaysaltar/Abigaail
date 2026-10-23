"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface MemoryChartPoint {
  t: number;
  heapFloor: number | null;
  rss: number | null;
  external: number | null;
}

const W = 1040;
const H = 260;
const PAD = { l: 8, r: 8, t: 24, b: 32 };
const BUCKET_MS = 15 * 60_000;

const fmtMb = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);
const SERIES = [
  { key: "heapFloor", label: "heap floor after GC", cls: "series" },
  { key: "rss", label: "RSS", cls: "series2" },
  { key: "external", label: "external (Buffers)", cls: "series3" },
] as const;

function ticks(max: number): number[] {
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return [0, step, 2 * step, 3 * step];
}

/**
 * Memory over the last day, lowest reading per 15 minutes: a leak is a floor
 * that keeps rising, not a high value. Starts are marked; buckets without data
 * are gaps, never zero. The table below carries every value.
 */
export function MemoryChart({ points, boots, limitMb }: { points: MemoryChartPoint[]; boots: number[]; limitMb: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  const titleId = useId();
  const n = points.length;
  const values = points.flatMap((p) => [p.heapFloor, p.rss, p.external]).filter((v): v is number => v !== null);
  const highest = Math.max(1, ...values);
  // The limit is drawn only when it is near enough to matter; otherwise it would flatten everything.
  const showLimit = limitMb !== null && limitMb <= 2 * highest;
  const yt = ticks(showLimit ? Math.max(highest, limitMb!) : highest);
  const top = yt[yt.length - 1]!;
  const cell = (W - PAD.l - PAD.r) / n;
  const x = (i: number) => PAD.l + (i + 0.5) * cell;
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const first = points[0]?.t ?? 0;
  const xAt = (ts: number) => PAD.l + ((ts - first) / BUCKET_MS) * cell;

  const paths = SERIES.map((s) => {
    const segs: string[] = [];
    let cur: string[] = [];
    points.forEach((p, i) => {
      const v = p[s.key];
      if (v === null) {
        if (cur.length) segs.push(cur.join(" "));
        cur = [];
      } else cur.push(`${cur.length ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (cur.length) segs.push(cur.join(" "));
    return { ...s, segs };
  });

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const i = Math.round((((e.clientX - box.left) / box.width) * W - PAD.l) / cell - 0.5);
    setHover(i >= 0 && i < n ? i : null);
  };
  const hp = hover === null ? undefined : points[hover];

  return (
    <div className="chartscroll" ref={scroller}>
      <div className="chartbox">
        <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <title id={titleId}>Memory over the last day: lowest heap after garbage collection, RSS and external memory per 15 minutes, with process starts marked</title>
          {yt.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
              {t > 0 ? <text className="axis" x={W - PAD.r} y={y(t) - 6} textAnchor="end">{fmtMb(t)}</text> : null}
            </g>
          ))}
          {points.map((p, i) => (i % 16 === 0 ? <text key={`x${i}`} className="axis" x={x(i)} y={H - 8} textAnchor="middle">{hhmm(p.t)}</text> : null))}
          {showLimit ? (
            <g>
              <line className="limit" x1={PAD.l} x2={W - PAD.r} y1={y(limitMb!)} y2={y(limitMb!)} />
              <text className="axis" x={PAD.l + 4} y={y(limitMb!) - 6}>heap limit {fmtMb(limitMb!)}</text>
            </g>
          ) : null}
          {boots.map((b) => (
            <line key={`b${b}`} className="boot" x1={xAt(b)} x2={xAt(b)} y1={PAD.t} y2={H - PAD.b}>
              <title>{`started ${hhmm(b)} UTC`}</title>
            </line>
          ))}
          {paths.map((s) => s.segs.map((d, i) => <path key={`${s.key}${i}`} className={s.cls} d={d} />))}
          {hp ? <line className="cross" x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={H - PAD.b} /> : null}
          <rect x={PAD.l} y={0} width={W - PAD.l - PAD.r} height={H} fill="transparent" />
        </svg>
        {hp ? (
          <div className={`tip${x(hover!) > W * 0.6 ? " left" : ""}`} style={{ left: `${(x(hover!) / W) * 100}%` }}>
            <b>{hhmm(hp.t)}–{hhmm(hp.t + BUCKET_MS)} UTC</b>
            {SERIES.map((s) => (
              <span key={s.key}>
                <br />
                <span className="muted">{s.label}: </span>
                {hp[s.key] === null ? "no data" : fmtMb(hp[s.key]!)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
