import type { AppSummary } from "@abigaail/insights";
import { ms, rate } from "@/lib/format";
import { livenessText } from "@/lib/liveness";
import { Status } from "./Status";

/** One line per app: name, state, uptime, p95, requests per minute. */
export function AppRows({ apps, now }: { apps: AppSummary[]; now: number }) {
  if (!apps.length) return <p className="empty">None.</p>;
  return (
    <ul className="rows">
      {apps.map((s) => (
        <li key={s.app.id}>
          <span className="name">
            <Status status={s.status} label={false} />
            <a href={`/apps/${encodeURIComponent(s.app.name)}`}>{s.app.name}</a>
          </span>
          <span className="line">{s.line}</span>
          <span className="fig">
            {livenessText(s.liveness, now).replace(/^Running for /, "")}
            <small>{s.liveness.kind === "running" ? "running" : "state"}</small>
          </span>
          <span className="fig">
            <span className={s.p95 === null ? "faint" : undefined}>{ms(s.p95)}</span>
            <small>p95</small>
          </span>
          <span className="fig">
            {rate(s.rpm)}
            <small>requests</small>
          </span>
        </li>
      ))}
    </ul>
  );
}
