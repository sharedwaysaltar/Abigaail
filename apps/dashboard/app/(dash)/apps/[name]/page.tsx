import { appSummary, dependsOn, earlier, fourNumbers, responseSeries, routesThatChanged, type RouteChange } from "@abigaail/insights";
import { notFound } from "next/navigation";
import { Figures } from "@/components/Figures";
import { ResponseChart } from "@/components/ResponseChart";
import { Status } from "@/components/Status";
import { reader } from "@/lib/data";
import { ago, hourLabel, ms, pct, when } from "@/lib/format";
import { livenessText } from "@/lib/liveness";
import { regionInfo } from "@/lib/regions";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const CHANGE: Record<RouteChange["kind"], (c: RouteChange) => string> = {
  new: (c) => `new since this release${c.now !== null ? `, ${c.now} requests last hour` : ""}`,
  slower: (c) => `slower: p95 ${ms(c.now)}, usually ${ms(c.usual)}`,
  faster: (c) => `faster: p95 ${ms(c.now)}, usually ${ms(c.usual)}`,
  busier: (c) => `busier: ${c.now} requests last hour, usually ${Math.round(c.usual ?? 0)}`,
  quieter: (c) => `quieter: ${c.now} requests last hour, usually ${Math.round(c.usual ?? 0)}`,
};

export default async function AppPage({ params }: { params: Promise<{ name: string }> }) {
  await requireSession();
  const { name } = await params;
  const r = reader();
  const app = r.appByName(decodeURIComponent(name));
  if (!app) notFound();
  const now = Date.now();
  const s = appSummary(r, app, now);
  const boot = r.lastBoot(app.id);
  const series = responseSeries(r, app.id, now);
  const deps = dependsOn(r, app.id, now);
  const routes = routesThatChanged(r, app.id, now);
  const past = earlier(r, app.id, now);
  const region = app.region ? regionInfo(app.region) : undefined;
  const top = s.top && s.top.severity !== "unknown" ? s.top : undefined;
  const hasPoints = series.some((p) => p.p95 !== null);

  return (
    <main>
      <div className="crumb"><a href="/">Overview</a> / {app.name}</div>
      <div className="hero" style={{ paddingTop: 20 }}>
        <h1>{app.name}</h1>
        <div className="meta">
          <Status status={s.status} />
          <span>{livenessText(s.liveness, now)}</span>
          {boot ? <span>release <span className="mono">{boot.release}</span></span> : null}
          {app.region ? <span><span className="mono">{app.region}</span>{region ? ` ${region.city}` : " (not on the map)"}</span> : null}
          {app.disabled_at !== null ? <span>disabled {when(app.disabled_at)}</span> : null}
        </div>
      </div>

      <section className="first">
        {top ? (
          <div className={`issue${s.status === "red" ? " red" : ""}`}>
            <div>
              <h3>What happened</h3>
              <p>{top.summary}</p>
              {top.cause ? <p className="muted">{top.cause}</p> : null}
              <p className="since">Since {when(top.first_seen)} ({ago(top.first_seen, now)}), seen in {top.hits} run{top.hits === 1 ? "" : "s"}.</p>
            </div>
            <div>
              <h3>What to do</h3>
              <p>{top.action}</p>
              {s.open.filter((f) => f.severity !== "info").length > 1 ? (
                <p className="since">{s.open.filter((f) => f.severity !== "info").length - 1} more open finding(s) for this app.</p>
              ) : null}
            </div>
          </div>
        ) : s.status === "grey" ? (
          <p className="calm"><Status status="grey" label={false} />{s.top?.summary ?? "Not enough data to say whether it is healthy."}</p>
        ) : (
          <p className="calm"><Status status="green" label={false} />Nothing needs you.</p>
        )}
      </section>

      <section>
        <h2>Last 15 minutes</h2>
        <Figures measures={fourNumbers(r, app.id, now)} />
      </section>

      <section>
        <h2>Response time, last 24 hours</h2>
        {hasPoints ? (
          <>
            <ResponseChart points={series} />
            <div className="legend">
              <span className="key"><i className="k-line" />p95 per hour</span>
              <span className="key"><i className="k-band" />normal for that hour</span>
              <span className="key"><i className="k-above" />above normal</span>
              <span className="key"><i className="k-gap" />no data or too few requests</span>
            </div>
            <details className="table">
              <summary>Show as a table</summary>
              <table>
                <thead><tr><th>Hour (UTC)</th><th className="r">p95</th><th className="r">Usual</th><th className="r">Requests</th></tr></thead>
                <tbody>
                  {series.map((p) => (
                    <tr key={p.hour}>
                      <td>{hourLabel(p.hour)}</td>
                      <td className="r">{p.p95 !== null ? ms(p.p95) : p.state === "no-data" ? "no data" : p.state === "building" ? "building" : "too few"}</td>
                      <td className="r">{p.band ? ms(p.band.mid) : "—"}</td>
                      <td className="r">{p.requests}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        ) : (
          <p className="empty">Too little data: no hour in the last day had enough requests to chart.</p>
        )}
      </section>

      <div className="cols">
        <section>
          <h2>Depends on</h2>
          {deps.length ? (
            <ul className="plain">
              {deps.map((d) => (
                <li key={d.host} style={{ display: "block" }}>
                  <span className="mono">{d.host}</span>
                  <div className="small muted num">
                    {d.calls === 0
                      ? "no calls in the last hour"
                      : d.failedPct === null
                        ? `${d.calls} call${d.calls === 1 ? "" : "s"} last hour, too few to judge`
                        : <>
                            <span style={d.failedPct >= 5 ? { color: "var(--red)" } : undefined}>{pct(d.failedPct)} failed</span>
                            {` · p95 ${ms(d.p95)}${d.usualP95 !== null ? `, usually ${ms(d.usualP95)}` : ""} · ${d.calls} calls`}
                          </>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No outbound calls seen in the last day.</p>
          )}
        </section>

        <section>
          <h2>Routes that changed</h2>
          {routes.changes.length ? (
            <ul className="plain">
              {routes.changes.map((c) => (
                <li key={`${c.kind}${c.route}`} style={{ display: "block" }}>
                  <span className="mono">{c.route}</span>
                  <div className="small muted">{CHANGE[c.kind](c)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{routes.reason === "no baseline yet" ? "No history to compare with yet." : "No route changed notably in the last hour."}</p>
          )}
        </section>

        <section>
          <h2>Earlier</h2>
          {past.length ? (
            <ul className="plain">
              {past.map((e) => (
                <li key={e.kind === "deploy" ? `d${e.release}${e.ts}` : `f${e.finding.id}`} style={{ display: "block" }}>
                  <div className="small faint">{when(e.ts)}</div>
                  {e.kind === "deploy" ? (
                    <div>Deployed <span className="mono">{e.release}</span> <span className="muted small">({e.environment})</span></div>
                  ) : (
                    <div>
                      {e.finding.summary}{" "}
                      <span className="muted small">{e.finding.state === "resolved" ? "resolved" : "noted"}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Nothing in the last 7 days.</p>
          )}
        </section>
      </div>
    </main>
  );
}
