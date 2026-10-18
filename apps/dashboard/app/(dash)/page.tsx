import { appSummary, headline, servers } from "@abigaail/insights";
import { AppRows } from "@/components/AppRows";
import { Status, StatusMark } from "@/components/Status";
import { WorldMap } from "@/components/WorldMap";
import { reader } from "@/lib/data";
import { ms, rate, STATUS_LABEL } from "@/lib/format";
import { livenessText } from "@/lib/liveness";
import { regionInfo } from "@/lib/regions";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Overview({ searchParams }: { searchParams: Promise<{ region?: string }> }) {
  await requireSession();
  const r = reader();
  const now = Date.now();
  const all = r.listApps();
  const summaries = all.filter((a) => a.disabled_at === null).map((a) => appSummary(r, a, now));
  const disabled = all.length - summaries.length;
  const { servers: list, unplaced } = servers(summaries, regionInfo);
  const head = headline(summaries);
  const { region } = await searchParams;
  // With nothing chosen, show the server that most needs attention.
  const chosen = list.find((s) => s.region === region) ?? list[0];

  return (
    <main>
      <div className="hero">
        <h1>
          <StatusMark status={head.status} size={16} />
          {head.text}
        </h1>
        <p>
          {summaries.length} app{summaries.length === 1 ? "" : "s"} on {list.length} server{list.length === 1 ? "" : "s"}
          {unplaced.length ? `, ${unplaced.length} not on the map` : ""}
          {disabled ? `, ${disabled} disabled` : ""}.
        </p>
      </div>

      {list.length ? (
        <section className="first">
          <div className="mapwrap">
            <WorldMap servers={list} {...(chosen ? { selected: chosen.region } : {})} />
            <div>
              <h2>Servers</h2>
              <ul className="servers">
                {list.map((s) => (
                  <li key={s.region}>
                    <a href={`/?region=${encodeURIComponent(s.region)}`} aria-current={s.region === chosen?.region ? "true" : undefined}>
                      <StatusMark status={s.status} />
                      <span className="code">{s.region}</span>
                      <span className="city">{s.info.city}</span>
                      <span className="count">{s.apps.length}</span>
                      <span className="sr-only">{STATUS_LABEL[s.status]}</span>
                    </a>
                  </li>
                ))}
              </ul>
              {chosen ? (
                <div className="panel">
                  <h3>
                    <span className="mono">{chosen.region}</span>
                    <span className="muted">{chosen.info.city}</span>
                  </h3>
                  <ul className="plain">
                    {chosen.apps.map((s) => (
                      <li key={s.app.id} style={{ display: "block" }}>
                        <a href={`/apps/${encodeURIComponent(s.app.name)}`}><b style={{ fontWeight: 500 }}>{s.app.name}</b></a>{" "}
                        <Status status={s.status} />
                        <div className="small" style={{ color: "var(--ink-2)", marginTop: 4 }}>{s.line}</div>
                        <div className="small muted num" style={{ marginTop: 2 }}>
                          {livenessText(s.liveness, now)} · p95 {ms(s.p95)} · {rate(s.rpm)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section className={list.length ? undefined : "first"}>
        <h2>All apps</h2>
        {summaries.length ? (
          <AppRows apps={[...summaries].sort((a, b) => a.app.name.localeCompare(b.app.name))} now={now} />
        ) : (
          <p className="empty">No apps yet. Create one with npm run app:create -- &lt;name&gt;.</p>
        )}
      </section>

      {unplaced.length ? (
        <section>
          <h2>Not on the map</h2>
          <ul className="plain">
            {unplaced.map((s) => (
              <li key={s.app.id}>
                <a href={`/apps/${encodeURIComponent(s.app.name)}`}>{s.app.name}</a>
                <span className="grow muted small">
                  {s.app.region ? <>Unknown region code <span className="mono">{s.app.region}</span></> : "No region sent. Set ABIGAAIL_REGION (e.g. LON1) in the app's environment."}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
