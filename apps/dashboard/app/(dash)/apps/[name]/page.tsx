import { appRetention, appSummary, dependsOn, earlier, fourNumbers, responseSeries, routesThatChanged, usageNumbers, type RouteChange } from "@abigaail/insights";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { Figures } from "@/components/Figures";
import { ResponseChart } from "@/components/ResponseChart";
import { Cause, Scrubbed } from "@/components/Scrubbed";
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

const count = (v: number) => Math.round(v).toLocaleString("en-GB");

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
  const usage = usageNumbers(r, app.id, now);
  const kept = appRetention(r, app.id);
  const errors = r.topErrors(app.id, now - 24 * 3_600_000, now + 1);
  const region = app.region ? regionInfo(app.region) : undefined;
  const top = s.top && s.top.severity !== "unknown" ? s.top : undefined;
  const hasPoints = series.some((p) => p.p95 !== null);
  const more = s.open.filter((f) => f.severity !== "info").length - 1;

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
        <AppNav name={app.name} current="overview" />
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
              {more > 0 ? (
                <p className="since">
                  <a href={`/findings?app=${encodeURIComponent(app.name)}`}>{more} more open finding{more === 1 ? "" : "s"}</a> for this app.
                </p>
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

      <section>
        <h2>Usage, last 24 hours</h2>
        <div className="figures usagefigs">
          <div className="figure">
            <div className="label">Requests</div>
            <div className={`value${usage.requests === null ? " grey" : ""}`}>{usage.requests === null ? "—" : count(usage.requests)}</div>
            <div className="usual">
              {usage.requests === null
                ? "No data in the last day"
                : usage.hoursWithData < 24
                  ? `${usage.hoursWithData} of 24 hours had data`
                  : "Humans only, bots and probes left out"}
            </div>
          </div>
          <div className="figure">
            <div className="label">Unique humans, {usage.uniques.day}</div>
            <div className={`value${usage.uniques.value === null ? " grey" : ""}`}>{usage.uniques.value === null ? "—" : count(usage.uniques.value)}</div>
            <div className="usual">
              {usage.uniques.value === null
                ? "Too little data"
                : usage.uniques.usual === null
                  ? "No usual value yet"
                  : `Usually ${count(usage.uniques.usual)} on a ${usage.uniques.weekday}`}
            </div>
            <div className="faint small">Counted per UTC day; the same visitor can't be linked across days, by design.</div>
          </div>
          <div className="figure span2">
            <div className="label">Top routes</div>
            {usage.topRoutes.length ? (
              <ul className="toplist">
                {usage.topRoutes.map((t) => (
                  <li key={t.route}><span className="mono">{t.route}</span><span className="num">{count(t.requests)}</span></li>
                ))}
              </ul>
            ) : <div className="usual">No data in the last day</div>}
          </div>
        </div>
        <div className="cols usagecols">
          <div>
            <h3 className="minor">Referrers</h3>
            {usage.topReferrers.length ? (
              <ul className="toplist">
                {usage.topReferrers.map((t) => (
                  <li key={t.domain}><span className="mono">{t.domain}</span><span className="num">{count(t.requests)}</span></li>
                ))}
              </ul>
            ) : <p className="empty small">No referrers in the last day.</p>}
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <h3 className="minor">Noticed</h3>
            {usage.noticed.length ? (
              <ul className="plain">
                {usage.noticed.map((f) => (
                  <li key={f.id} style={{ display: "block" }}>
                    <div>{f.summary}</div>
                    <div className="small muted">{f.action}</div>
                  </li>
                ))}
              </ul>
            ) : <p className="empty small">Nothing unusual in how the app is used.</p>}
          </div>
        </div>
      </section>

      <section>
        <h2>Errors, last 24 hours</h2>
        {errors.length ? (
          <>
            <ul className="plain errlist">
              {errors.map((e, i) => (
                <li key={i}>
                  <div>
                    <span className="mono">{e.error_type}</span>
                    {e.code ? <span className="mono muted"> {e.code}</span> : null}
                    {e.routes.length ? (
                      <span className="muted small">
                        {" on "}
                        {e.routes.slice(0, 3).map((r, k) => (
                          <span key={r}>{k ? ", " : ""}<span className="mono">{r}</span></span>
                        ))}
                        {e.routes.length > 3 ? ` and ${e.routes.length - 3} more` : ""}
                      </span>
                    ) : null}
                  </div>
                  <div className="small">
                    {e.message ? <Scrubbed text={e.message} /> : <span className="faint">no message</span>}
                    {e.cause_type || e.cause_code || e.cause_message ? (
                      <>
                        {" · "}
                        <Cause type={e.cause_type} code={e.cause_code} message={e.cause_message} />
                      </>
                    ) : null}
                  </div>
                  <div className="small muted num">{count(e.n)} time{e.n === 1 ? "" : "s"} · last {when(e.last)}</div>
                </li>
              ))}
            </ul>
            <p className="small muted">
              Messages are cleaned in the app before they are sent: anything personal or unrecognised is replaced
              (<Scrubbed text="<email> <word>" />, ...), and the original never leaves the app.
            </p>
          </>
        ) : (
          <p className="empty">No errors in the last 24 hours.</p>
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
                      <span className="muted small">
                        {e.finding.resolved_reason === "not_observed" ? "not observed while Abigaail was down" : e.finding.state === "resolved" ? "resolved" : "noted"}
                      </span>
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

      {kept.eventsDays !== null ? (
        <p className="small muted">
          Raw events are deleted after {kept.eventsDays} days
          {kept.oldestEvent !== null ? ` (oldest stored: ${when(kept.oldestEvent)})` : ""}.
          {kept.rollupsDays !== null ? ` Hourly summaries are kept ${kept.rollupsDays} days.` : ""}
        </p>
      ) : null}
    </main>
  );
}
