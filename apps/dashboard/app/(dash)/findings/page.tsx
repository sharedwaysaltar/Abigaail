import { alertsByFinding, findingsFor, STATUS_FRESH_MS, systemFindingsView } from "@abigaail/insights";
import type { AlertItemRow, App, AppStatus, Finding } from "@abigaail/store";
import { Severity } from "@/components/Severity";
import { StatusMark } from "@/components/Status";
import { reader } from "@/lib/data";
import { ago, when } from "@/lib/format";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const RANK: Record<AppStatus, number> = { red: 0, amber: 1, grey: 2, green: 3 };

function value(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

const MARK: Record<AlertItemRow["status"], string> = { delivered: "✓", pending: "…", gave_up: "✗", suppressed: "–" };

/** "Alerted 14:05 · webhook ✓ · email ✗" per message about this finding. */
function AlertLine({ items }: { items: AlertItemRow[] | undefined }) {
  if (!items?.length) return null;
  const byMessage = new Map<string, AlertItemRow[]>();
  for (const i of items) {
    const key = `${i.change} ${i.created_at}`;
    byMessage.set(key, [...(byMessage.get(key) ?? []), i]);
  }
  return (
    <>
      {[...byMessage.values()].map((rows) => (
        <span key={`${rows[0]!.change}${rows[0]!.created_at}`}>
          <a href="/alerts">{rows[0]!.change === "firing" ? "Alerted" : "Recovery sent"}</a> {when(rows[0]!.created_at)}
          {rows.map((r) => ` · ${r.channel} ${MARK[r.status]}`).join("")}
        </span>
      ))}
    </>
  );
}

function FindingItem({ f, now, alerts }: { f: Finding; now: number; alerts?: AlertItemRow[] | undefined }) {
  const evidence = Object.entries(f.evidence);
  return (
    <li className="finding" id={`finding-${f.id}`}>
      <div className="fhead">
        <Severity severity={f.severity} />
        <span className="fsum">{f.summary}</span>
      </div>
      <div className="small muted fmeta">
        <span className="mono">{f.agent}</span>
        {f.state === "resolved" && f.resolved_at !== null ? (
          f.resolved_reason === "not_observed" ? (
            <span>not observed while Abigaail was down; closed {when(f.resolved_at)}, last seen {when(f.last_seen)}</span>
          ) : (
            <span>resolved {when(f.resolved_at)} ({ago(f.resolved_at, now)})</span>
          )
        ) : (
          <span>since {when(f.first_seen)} ({ago(f.first_seen, now)})</span>
        )}
        <span>last seen {ago(f.last_seen, now)}</span>
        <span>seen in {f.hits} run{f.hits === 1 ? "" : "s"}</span>
        <AlertLine items={alerts} />
      </div>
      <details className="fdetail">
        <summary>Details</summary>
        <dl>
          {f.cause ? (<><dt>Likely cause</dt><dd>{f.cause}</dd></>) : null}
          <dt>What to do</dt>
          <dd>{f.action}</dd>
          <dt>Resolves</dt>
          <dd>{f.resolves === "fact" ? "as soon as it is no longer true" : "after 3 runs in a row without it"}</dd>
          <dt>Fingerprint</dt>
          <dd className="mono">{f.fingerprint}</dd>
        </dl>
        {evidence.length ? (
          <table>
            <thead><tr><th>Evidence</th><th>Value</th></tr></thead>
            <tbody>
              {evidence.map(([k, v]) => (
                <tr key={k}><td>{k.replace(/_/g, " ")}</td><td className="mono ev">{value(v)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </details>
    </li>
  );
}

export default async function FindingsPage({ searchParams }: { searchParams: Promise<{ app?: string; state?: string }> }) {
  await requireSession();
  const q = await searchParams;
  const state = q.state === "resolved" ? "resolved" : "open";
  const r = reader();
  const now = Date.now();
  const all = r.listApps();
  const chosen: App | undefined = q.app ? all.find((a) => a.name === q.app) : undefined;
  // One app at a time: every read is scoped by app_id.
  const groups = (chosen ? [chosen] : all).map((app) => ({
    app,
    status: r.appStatus(app.id, { now, freshMs: STATUS_FRESH_MS }).status,
    findings: findingsFor(r, app.id, { state, now }),
    alerts: alertsByFinding(r, app.id, now),
  }));
  groups.sort((a, b) => RANK[a.status] - RANK[b.status] || a.app.name.localeCompare(b.app.name));
  const withFindings = groups.filter((g) => g.findings.length);
  const quiet = groups.filter((g) => !g.findings.length);
  const own = state === "open" && !chosen ? systemFindingsView(r) : [];
  const ownAlerts = own.length ? alertsByFinding(r, null, now) : new Map<number, AlertItemRow[]>();
  const link = (over: { app?: string | null; state?: string }) => {
    const p = new URLSearchParams();
    const a = over.app === undefined ? chosen?.name : over.app;
    if (a) p.set("app", a);
    if ((over.state ?? state) === "resolved") p.set("state", "resolved");
    const s = p.toString();
    return `/findings${s ? `?${s}` : ""}`;
  };

  return (
    <main>
      <div className="hero" style={{ paddingBottom: 24 }}>
        <h1>Findings</h1>
        <p>{state === "open" ? "Open now, worst first." : "Resolved in the last 7 days, newest first."} {chosen ? `App ${chosen.name}.` : "All apps."}</p>
        <nav className="subnav" aria-label="Which findings">
          <a href={link({ state: "open" })} aria-current={state === "open" ? "page" : undefined}>Open</a>
          <a href={link({ state: "resolved" })} aria-current={state === "resolved" ? "page" : undefined}>Resolved</a>
          <span className="sep" aria-hidden="true" />
          <a href={link({ app: null })} aria-current={!chosen ? "page" : undefined}>All apps</a>
          {all.map((a) => (
            <a key={a.id} href={link({ app: a.name })} aria-current={chosen?.id === a.id ? "page" : undefined}>{a.name}</a>
          ))}
        </nav>
      </div>

      {q.app && !chosen ? <p className="empty">No app called {q.app}.</p> : null}

      {withFindings.map(({ app, status, findings, alerts }, i) => (
        <section key={app.id} className={i === 0 ? "first" : undefined}>
          <h2 className="grouph">
            <StatusMark status={status} />
            <a href={`/apps/${encodeURIComponent(app.name)}`}>{app.name}</a>
            <span className="faint">{findings.length}</span>
          </h2>
          <ul className="plain findings">
            {findings.map((f) => <FindingItem key={f.id} f={f} now={now} alerts={alerts.get(f.id)} />)}
          </ul>
        </section>
      ))}

      {own.length ? (
        <section className={withFindings.length ? undefined : "first"}>
          <h2 className="grouph">Abigaail itself <span className="faint">{own.length}</span></h2>
          <ul className="plain findings">
            {own.map((f) => <FindingItem key={f.id} f={f} now={now} alerts={ownAlerts.get(f.id)} />)}
          </ul>
        </section>
      ) : null}

      {quiet.length ? (
        <section className={withFindings.length || own.length ? undefined : "first"}>
          <p className="empty">
            {state === "open" ? "Nothing open" : "Nothing resolved in the last 7 days"} for {quiet.map((g) => g.app.name).join(", ")}.
          </p>
        </section>
      ) : null}
      {!all.length ? <p className="empty">No apps yet.</p> : null}
    </main>
  );
}
