import { agentsView, retentionView, systemFindingsView } from "@abigaail/insights";
import { RunStrip } from "@/components/RunStrip";
import { Severity } from "@/components/Severity";
import { Status } from "@/components/Status";
import { AGENT_PURPOSE } from "@/lib/agents";
import { reader } from "@/lib/data";
import { ago, ms, span, when } from "@/lib/format";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  await requireSession();
  const r = reader();
  const now = Date.now();
  const rows = agentsView(r, r.listApps(), now);
  const own = systemFindingsView(r);
  const kept = retentionView(r);

  return (
    <main>
      <div className="hero">
        <h1>Agents</h1>
        <p>Each runs on its own schedule, in its own worker, with a hard timeout. Their status is what the Watchdog says.</p>
      </div>

      <section className="first">
        <ul className="plain agents">
          {rows.map((a) => {
            const failed = a.day.error + a.day.timeout;
            return (
              <li key={a.name}>
                <div className="agent-name">
                  <Status status={a.status} label={false} />
                  <span className="mono">{a.name}</span>
                </div>
                <div className="agent-what">
                  <div>{AGENT_PURPOSE[a.name] ?? "—"}</div>
                  {a.finding ? <div className="small red-text">{a.finding.summary}</div> : null}
                  {a.off ? <div className="small muted">{a.off}</div> : null}
                  <div className="small muted" hidden={!!a.off}>
                    {a.schedule ? `Every ${span(a.schedule.everyMs)}${a.schedule.timeoutMs ? `, timeout ${span(a.schedule.timeoutMs)}` : ""}` : "Not scheduled"}
                    {" · "}
                    {a.lastOkAt !== undefined ? `last good run ${ago(a.lastOkAt, now)}` : "no good run yet"}
                    {a.runs[0] && a.runs[0].outcome !== "ok" ? ` · last run ${a.runs[0].outcome}` : ""}
                  </div>
                </div>
                <div className="agent-runs">
                  {a.runs.length ? <RunStrip runs={a.runs} {...(a.schedule?.timeoutMs ? { timeoutMs: a.schedule.timeoutMs } : {})} /> : <span className="faint small">No runs yet</span>}
                </div>
                <div className="fig">
                  {ms(a.medianMs)}
                  <small>median{a.maxMs !== null ? `, max ${ms(a.maxMs)}` : ""}</small>
                </div>
                <div className="fig">
                  <span className={failed ? "red-text" : undefined}>{failed}</span>
                  <small>failed, 24 h</small>
                </div>
                <div className="fig">
                  {a.open}
                  <small>open findings</small>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="legend">
          <span className="key"><i className="k-run" />ok run, height = share of timeout</span>
          <span className="key"><i className="k-runbad" />error or timeout</span>
          <span className="key"><i className="k-runskip" />skipped (still running)</span>
        </div>
        <details className="table">
          <summary>Show runs as a table</summary>
          <table>
            <thead><tr><th>Agent</th><th>Started (UTC)</th><th>Outcome</th><th className="r">Duration</th><th className="r">Findings</th></tr></thead>
            <tbody>
              {rows.flatMap((a) =>
                a.runs.slice(0, 10).map((run) => (
                  <tr key={run.id}>
                    <td className="mono">{a.name}</td>
                    <td>{when(run.started_at)}</td>
                    <td>{run.outcome}{run.error_class ? ` (${run.error_class})` : ""}</td>
                    <td className="r">{ms(run.duration_ms)}</td>
                    <td className="r">{run.findings}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </details>
      </section>

      <section>
        <h2>Data kept</h2>
        {kept.length ? (
          <>
            <table>
              <thead><tr><th>What</th><th>Kept</th><th className="r">Deleted in the last run</th></tr></thead>
              <tbody>
                {kept.map((k) => (
                  <tr key={k.name}>
                    <td>{k.label}</td>
                    <td>{k.keepDays ? `${k.keepDays} days, then deleted` : "until they expire (2 h idle, 12 h at most)"}</td>
                    <td className="r">{k.lastDeleted ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              {kept[0]!.lastRunAt !== null ? `Last run ${ago(kept[0]!.lastRunAt, now)}. ` : "Not run yet. "}
              Deleted rows are overwritten and removed from the database file, not just hidden. Open findings,
              apps and their releases are kept. The periods are set on the server (ABIGAAIL_RETAIN_*_DAYS).
            </p>
          </>
        ) : (
          <p className="empty">The server has not recorded its retention periods yet.</p>
        )}
      </section>

      <section>
        <h2>Abigaail itself</h2>
        {own.length ? (
          <ul className="plain">
            {own.map((f) => (
              <li key={f.id} style={{ display: "block" }}>
                <Severity severity={f.severity} /> <span>{f.summary}</span>
                <div className="small muted">{f.action}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="calm"><Status status="green" label={false} />Nothing to report.</p>
        )}
      </section>
    </main>
  );
}
