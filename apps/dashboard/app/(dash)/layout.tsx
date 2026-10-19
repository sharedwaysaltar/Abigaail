import { appSummary, topFinding } from "@abigaail/insights";
import { StatusMark } from "@/components/Status";
import { Wordmark } from "@/components/Wordmark";
import { reader } from "@/lib/data";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  const r = reader();
  const now = Date.now();
  const apps = r.listApps().filter((a) => a.disabled_at === null).map((a) => ({ app: a, status: appSummary(r, a, now).status }));
  const own = topFinding(r.systemFindings());
  return (
    <div className="page">
      <header className="top">
        <Wordmark />
        {apps.length ? (
          <details className="switcher">
            <summary>Apps</summary>
            <ul>
              {apps.map(({ app, status }) => (
                <li key={app.id}>
                  <a href={`/apps/${encodeURIComponent(app.name)}`}>
                    <StatusMark status={status} />
                    {app.name}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <nav className="topnav" aria-label="Views">
          <a href="/findings">Findings</a>
          <a href="/agents">Agents</a>
        </nav>
        <span className="spacer" />
        <span className="muted small">{user}</span>
        <form method="post" action="/api/logout">
          <button className="linkish small" type="submit">Sign out</button>
        </form>
      </header>
      {children}
      <footer className="foot">
        <StatusMark status={own ? (own.severity === "critical" ? "red" : own.severity === "warning" ? "amber" : "grey") : "green"} />
        <span>{own ? `Abigaail itself: ${own.summary}` : "Abigaail itself: agents running, nothing to report."}</span>
      </footer>
    </div>
  );
}
