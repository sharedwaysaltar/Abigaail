import type { Server } from "@abigaail/insights";
import { STATUS_LABEL } from "@/lib/format";
import { LAND, MAP } from "@/lib/worldmap";

/** Equirectangular: x from longitude, y from latitude, in grid cells. */
const project = (lat: number, lon: number) => ({
  x: (lon + 180) / MAP.cell,
  y: (MAP.top - Math.max(MAP.bottom, Math.min(MAP.top, lat))) / MAP.cell,
});

/**
 * Flat dotted world map. Pins sit at each region's real coordinates and link
 * to ?region=CODE, so selecting one works without JavaScript.
 */
export function WorldMap({ servers, selected }: { servers: Server[]; selected?: string }) {
  const dots: React.ReactElement[] = [];
  LAND.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") dots.push(<circle key={`${x}-${y}`} className="land" cx={x + 0.5} cy={y + 0.5} r={0.32} />);
  });
  // Worst last, so a failing pin is drawn on top of its neighbours.
  const order = [...servers].reverse();
  return (
    <svg className="worldmap" viewBox={`0 0 ${MAP.cols} ${MAP.rows}`} role="img" aria-label={`Map of ${servers.length} server regions`}>
      <g aria-hidden="true">{dots}</g>
      {order.map((s) => {
        const { x, y } = project(s.info.lat, s.info.lon);
        const label = `${s.region}, ${s.info.city}: ${STATUS_LABEL[s.status]}, ${s.apps.length} app${s.apps.length === 1 ? "" : "s"}`;
        return (
          <a key={s.region} href={`/?region=${encodeURIComponent(s.region)}`} aria-label={label}>
            <title>{label}</title>
            <circle className="pin-hit" cx={x} cy={y} r={3} />
            {s.status === "red" ? <circle className="pulse" cx={x} cy={y} r={1.3} /> : null}
            {selected === s.region ? <circle className="selected" cx={x} cy={y} r={2.3} /> : null}
            <circle className="selected-focus" cx={x} cy={y} r={2.3} fill="none" />
            <circle className="pin-ring" cx={x} cy={y} r={s.status === "red" ? 1.75 : 1.45} />
            <circle className={`pin ${s.status}`} cx={x} cy={y} r={s.status === "red" ? 1.3 : s.status === "amber" ? 0.85 : 1} />
          </a>
        );
      })}
    </svg>
  );
}
