import { appSummary, releasesView, releaseView } from "@abigaail/insights";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { SeverityMark } from "@/components/Severity";
import { Status } from "@/components/Status";
import { reader } from "@/lib/data";
import { when } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { SourceMapHint, VERDICT_LABEL } from "@/components/Verdict";

export const dynamic = "force-dynamic";

export default async function ReleasesPage({ params }: { params: Promise<{ name: string }> }) {
  await requireSession();
  const { name } = await params;
  const r = reader();
  const app = r.appByName(decodeURIComponent(name));
  if (!app) notFound();
  const now = Date.now();
  const s = appSummary(r, app, now);
  const rows = releasesView(r, app.id);
  const base = `/apps/${encodeURIComponent(app.name)}/releases`;
  // One hint for the whole page, from the latest judged release (DECISIONS #135).
  const latest = rows.find((x) => x.deployed);
  const compiled = latest ? (releaseView(r, app.id, latest.release, now)?.compiledFrames ?? false) : false;

  return (
    <main>
      <div className="crumb"><a href="/">Overview</a> / <a href={`/apps/${encodeURIComponent(app.name)}`}>{app.name}</a> / Releases</div>
      <div className="hero" style={{ paddingTop: 20, paddingBottom: 24 }}>
        <h1>{app.name}</h1>
        <div className="meta">
          <Status status={s.status} />
          <span>Each release against the same routes at the same hours before it, as the Rollout Safety agent judges it</span>
        </div>
        <AppNav name={app.name} current="releases" />
      </div>

      <section className="first">
        <h2>Releases</h2>
        {rows.length ? (
          <table>
            <thead>
              <tr><th>Release</th><th>Deployed (UTC)</th><th>Replaced</th><th>Commit</th><th>Lockfile</th><th>Verdict</th></tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.release}>
                  <td className="mono"><a href={`${base}/${encodeURIComponent(x.release)}`}>{x.release}</a></td>
                  <td>{x.deployed ? when(x.at) : <span className="muted">first seen {when(x.at)}</span>}</td>
                  <td className="mono">{x.replaced ?? <span className="muted">—</span>}</td>
                  <td className="mono">{x.commit ? x.commit.slice(0, 12) : <span className="muted">not sent</span>}</td>
                  <td>{x.lockfileChanged === null ? <span className="muted">unknown</span> : x.lockfileChanged ? "changed" : "same"}</td>
                  <td>
                    {x.finding ? (
                      <span className="status">
                        <SeverityMark severity={x.finding.severity} />
                        <span className="status-label">{VERDICT_LABEL[x.verdict ?? "too_little"]}</span>
                        {x.finding.state === "resolved" ? <span className="muted small"> (judged)</span> : null}
                      </span>
                    ) : (
                      <span className="muted">not judged</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No release seen yet.</p>
        )}
        <p className="small muted">
          A release is judged for 24 hours after its deploy, or until the next one: requests that matter on that release only, against
          the same routes at the same hours of the week before it. &quot;Recommend rollback&quot; needs both high impact and high
          confidence; otherwise it says watch, looks fine, or too little traffic yet.
          Commit, previous release and lockfile hash come from the deploy step (README: Deploy metadata).
        </p>
        {compiled ? <SourceMapHint /> : null}
      </section>
    </main>
  );
}
