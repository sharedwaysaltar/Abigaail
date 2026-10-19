import { appSummary } from "@abigaail/insights";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { LiveFeed } from "@/components/LiveFeed";
import { Status } from "@/components/Status";
import { reader } from "@/lib/data";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LivePage({ params }: { params: Promise<{ name: string }> }) {
  await requireSession();
  const { name } = await params;
  const r = reader();
  const app = r.appByName(decodeURIComponent(name));
  if (!app) notFound();
  const s = appSummary(r, app, Date.now());
  return (
    <main>
      <div className="crumb"><a href="/">Overview</a> / <a href={`/apps/${encodeURIComponent(app.name)}`}>{app.name}</a> / Live</div>
      <div className="hero" style={{ paddingTop: 20, paddingBottom: 24 }}>
        <h1>{app.name}</h1>
        <div className="meta">
          <Status status={s.status} />
          <span>Events as they are stored, without visitor data</span>
        </div>
        <AppNav name={app.name} current="live" />
      </div>
      <LiveFeed app={app.name} />
    </main>
  );
}
