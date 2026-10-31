import { appSummary, releaseView, type SignalKind } from "@abigaail/insights";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { Severity } from "@/components/Severity";
import { Status } from "@/components/Status";
import { SourceMapHint, VERDICT_LABEL } from "@/components/Verdict";
import { reader } from "@/lib/data";
import { ms, pct, span, when } from "@/lib/format";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const share = (x: number | null) => (x === null ? "—" : pct(x * 100));
const CHANGED: Record<SignalKind, string> = {
  errors: "more 5xx",
  client_errors: "more 4xx",
  latency: "slower",
  quiet: "went quiet",
  app_latency: "slower",
  new_error: "new error",
  loop: "crash loop",
};
const BASELINE: Record<string, string> = {
  "hour-of-week": "the same hours of the week over the last 4 weeks",
  daily: "the same hours on the last 7 days",
  previous_release: "the previous release's last hours (no hour-of-week history yet)",
  none: "nothing: there is no history before the deploy",
};
const RULE: Record<string, string> = {
  crash_loop: "a crash loop that began with this release",
  route_failing: "a route carrying at least 10% of the usual traffic fails for at least 20% of its requests",
  excess_failures: "extra failures are at least 5% of all requests since the deploy",
  route_slow: "a route carrying at least 10% of the usual traffic is 2.5× as slow as usual",
  app_slow: "at least half of all requests are slower than usual",
  route_quiet: "a route carrying at least 10% of the usual traffic went quiet",
};

export default async function ReleasePage({ params }: { params: Promise<{ name: string; release: string }> }) {
  await requireSession();
  const { name, release } = await params;
  const r = reader();
  const app = r.appByName(decodeURIComponent(name));
  if (!app) notFound();
  const now = Date.now();
  const v = releaseView(r, app.id, decodeURIComponent(release), now);
  if (!v) notFound();
  const s = appSummary(r, app, now);
  const f = v.finding;
  const impact = f?.evidence.impact as { met: boolean; rule: string | null; excess: number; excessShare: number } | undefined;
  const confidence = f?.evidence.confidence as { met: boolean; corrected: number | null; why: string | null } | undefined;
  const tests = f?.evidence.tests as number | undefined;
  const looks = f?.evidence.looks as number | undefined;
  const d = v.deploy;

  return (
    <main>
      <div className="crumb">
        <a href="/">Overview</a> / <a href={`/apps/${encodeURIComponent(app.name)}`}>{app.name}</a> /{" "}
        <a href={`/apps/${encodeURIComponent(app.name)}/releases`}>Releases</a> / <span className="mono">{v.release}</span>
      </div>
      <div className="hero" style={{ paddingTop: 20, paddingBottom: 24 }}>
        <h1>{app.name} · <span className="mono">{v.release}</span></h1>
        <div className="meta">
          <Status status={s.status} />
          <span>{d.deployed_at !== null ? `Deployed ${when(d.deployed_at)}${d.replaced_release ? `, replacing ${d.replaced_release}` : ""}` : `First seen ${when(d.first_seen)}`}</span>
        </div>
        <AppNav name={app.name} current="releases" />
      </div>

      <section className="first">
        <h2>Verdict</h2>
        {v.notJudged ? (
          <p className="calm">{v.notJudged}</p>
        ) : f ? (
          <div>
            <p style={{ margin: 0 }}>
              <Severity severity={f.severity} /> <strong>{VERDICT_LABEL[(f.evidence.verdict as keyof typeof VERDICT_LABEL) ?? "too_little"]}</strong>
              {f.state === "resolved" ? <span className="muted small"> · judged until {when(f.last_seen)}</span> : null}
            </p>
            <p>{f.summary}</p>
            {f.cause ? <p className="small muted">{f.cause}</p> : null}
            <p className="small muted">{f.action}</p>
            {impact && confidence ? (
              <ul className="plain small">
                <li style={{ display: "block" }}>
                  <strong>Impact</strong>{" "}
                  {impact.rule ? <>met: {RULE[impact.rule] ?? impact.rule}.</> : "below the rollback bar."}{" "}
                  <span className="muted num">Extra failures since the deploy: {Math.round(impact.excess)} ({pct(impact.excessShare * 100)} of requests).</span>
                </li>
                <li style={{ display: "block" }}>
                  <strong>Confidence</strong>{" "}
                  {confidence.met ? "met" : confidence.why ? `not met: ${confidence.why}` : "not needed"}.{" "}
                  <span className="muted num">
                    Each test is exact and one-sided, corrected for {tests ?? "?"} tests in this look and {looks ?? "?"} looks at the release
                    {confidence.corrected !== null ? ` (corrected p ${confidence.corrected < 1e-6 ? "< 0.000001" : confidence.corrected.toPrecision(2)})` : ""}.
                    A verdict is reported only after it held on 2 runs in a row.
                  </span>
                </li>
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="empty">Not judged yet: Rollout Safety runs every minute after a deploy.</p>
        )}
      </section>

      {!v.notJudged ? (
        <section>
          <h2>Before and after, per route</h2>
          {v.routes.length ? (
            <table>
              <thead>
                <tr>
                  <th>Route</th><th className="r">Usual share</th><th className="r">Requests since</th>
                  <th className="r">5xx before → after</th><th className="r">4xx before → after</th><th className="r">p95 usual → now</th><th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {v.routes.map((x) => (
                  <tr key={x.route}>
                    <td className="mono">{x.route}</td>
                    <td className="r num">{share(x.usualShare)}</td>
                    <td className="r num">{x.after.requests}{x.expected !== null ? <span className="muted"> / ~{Math.round(x.expected)}</span> : null}</td>
                    <td className="r num">{share(x.before?.share5xx ?? null)} → {share(x.after.share5xx)}</td>
                    <td className="r num">
                      {share(x.before?.share4xx ?? null)} → {share(x.after.share4xx)}
                      {x.after.notFound ? <span className="muted"> ({x.after.notFound}× 404)</span> : null}
                    </td>
                    <td className="r num">{ms(x.before?.p95 ?? null)} → {ms(x.after.p95)}</td>
                    <td>
                      {x.dependency ? <span className="muted">failing because of {x.dependency.host} (Health)</span> : x.changed.length ? x.changed.map((c) => CHANGED[c]).join(", ") : <span className="muted">no</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No requests on this release yet.</p>
          )}
          <p className="small muted">
            {v.from !== null && v.to !== null ? `${when(v.from)} to ${when(v.to)} (${span(v.to - v.from)}), ` : ""}
            requests that matter on this release only, against {BASELINE[v.baseline ?? "none"]}. p95 &quot;now&quot; is the latest 30 minutes,
            past the first 5 after the deploy (a cold start is the Resilience agent&apos;s). &quot;Requests since&quot; shows the expected count after the slash.
          </p>
        </section>
      ) : null}

      {!v.notJudged ? (
        <section>
          <h2>Errors on this release</h2>
          {v.errors.length ? (
            <table>
              <thead><tr><th>Error</th><th>Route</th><th className="r">Count</th><th>Top frame</th><th /></tr></thead>
              <tbody>
                {v.errors.map((e) => (
                  <tr key={`${e.error_type} ${e.route} ${e.file}:${e.line}`}>
                    <td className="mono">{e.error_type}</td>
                    <td className="mono">{e.route ?? "—"}</td>
                    <td className="r num">{e.n}</td>
                    <td className="mono">{e.file ? `${e.file}:${e.line ?? "?"}${e.fn ? ` (${e.fn})` : ""}` : <span className="muted">no frame</span>}</td>
                    <td>{e.isNew ? "new in this release" : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No errors on this release.</p>
          )}
          {v.compiledFrames ? <SourceMapHint /> : null}
          {v.crashes.length ? (
            <>
              <h3>Restarts on this release</h3>
              <ul className="plain">
                {v.crashes.map((c) => (
                  <li key={c.ts} style={{ display: "block" }}>
                    <div className="small faint">{when(c.ts)}</div>
                    <div>{c.text}</div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {v.code ? (
        <section>
          <h2>Changed code involved</h2>
          {v.code.linkFailed ? (
            <p className="small"><strong>The GitHub link fails:</strong> {v.code.linkFailed}. Findings still name their frames.</p>
          ) : null}
          {v.code.status === "ok" ? (
            v.code.involved.length ? (
              <table>
                <thead><tr><th>Where</th><th>Behind</th><th>Changed in {v.release}</th></tr></thead>
                <tbody>
                  {v.code.involved.map((c) => (
                    <tr key={`${c.file}:${c.line}`}>
                      <td className="mono">{c.file}:{c.line}{c.fn ? ` (${c.fn})` : ""}</td>
                      <td>{c.what}</td>
                      <td>
                        {/* Only ever a github.com link, built from checked parts (codeUrl). */}
                        {c.url.startsWith("https://github.com/") ? (
                          <a href={c.url} target="_blank" rel="noopener noreferrer">
                            {c.match === "line" && c.lines ? `lines ${c.lines[0]}-${c.lines[1]}` : "the file, elsewhere"}
                          </a>
                        ) : (
                          c.match === "line" ? "these lines" : "the file, elsewhere"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="empty">None of this release&apos;s error frames, block functions or crash frames are in the {v.code.files} file{v.code.files === 1 ? "" : "s"} it changed.</p>
            )
          ) : (
            <p className="calm">Not matched: {v.code.why}.</p>
          )}
          <p className="small muted">
            {v.code.repo ? <>From GitHub&apos;s compare of <span className="mono">{v.code.repo}</span>{v.code.base && v.code.head ? <> <span className="mono">{v.code.base.slice(0, 7)}…{v.code.head.slice(0, 7)}</span></> : null}: {v.code.files} file{v.code.files === 1 ? "" : "s"} changed{v.code.truncated ? " (GitHub lists at most 300)" : ""}. </> : null}
            A frame counts when it is inside a changed hunk or within 3 lines of one. Abigaail keeps only paths and line ranges, never the code.
            {v.compiledFrames ? " Frames on compiled files cannot match: see the source map note above." : ""}
          </p>
        </section>
      ) : null}

      <section>
        <h2>From the deploy step</h2>
        <ul className="plain small">
          <li>Commit: {d.commit_sha ? <span className="mono">{d.commit_sha}</span> : <span className="muted">not sent (set ABIGAAIL_COMMIT, or make ABIGAAIL_RELEASE the commit SHA)</span>}</li>
          <li>Previous release: {d.previous_release ? <span className="mono">{d.previous_release}</span> : <span className="muted">not sent (ABIGAAIL_PREVIOUS_RELEASE); from the app&apos;s own events: {d.replaced_release ?? "none"}</span>}</li>
          <li>
            Lockfile: {d.lockfile_hash ? <span className="mono">{d.lockfile_hash.slice(0, 16)}…</span> : <span className="muted">not sent (ABIGAAIL_LOCKFILE_HASH)</span>}
            {v.row.lockfileChanged !== null ? <span className="muted"> · {v.row.lockfileChanged ? "changed from" : "same as"} the release it replaced</span> : null}
          </li>
        </ul>
      </section>
    </main>
  );
}
