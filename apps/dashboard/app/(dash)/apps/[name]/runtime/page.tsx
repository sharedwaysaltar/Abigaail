import { appSummary, runtimeView } from "@abigaail/insights";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { MemoryChart } from "@/components/MemoryChart";
import { Severity } from "@/components/Severity";
import { Status } from "@/components/Status";
import { reader } from "@/lib/data";
import { ms, when } from "@/lib/format";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const mb = (v: number | null) => (v === null ? "—" : v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
const LEAK_LABEL = { heap: "Heap floor after GC", external: "External memory (Buffers)", rss: "Memory (RSS) floor" } as const;

export default async function RuntimePage({ params }: { params: Promise<{ name: string }> }) {
  await requireSession();
  const { name } = await params;
  const r = reader();
  const app = r.appByName(decodeURIComponent(name));
  if (!app) notFound();
  const now = Date.now();
  const s = appSummary(r, app, now);
  const v = runtimeView(r, app.id, now);
  const hasMemory = v.memory.some((p) => p.heapFloor !== null || p.rss !== null);

  return (
    <main>
      <div className="crumb"><a href="/">Overview</a> / <a href={`/apps/${encodeURIComponent(app.name)}`}>{app.name}</a> / Runtime</div>
      <div className="hero" style={{ paddingTop: 20, paddingBottom: 24 }}>
        <h1>{app.name}</h1>
        <div className="meta">
          <Status status={s.status} />
          <span>Memory, event-loop blocks, restarts and startup, as the Resilience agent judges them</span>
        </div>
        <AppNav name={app.name} current="runtime" />
      </div>

      {!v.signals ? (
        <section className="first">
          <p className="calm">
            This app&apos;s SDK sends no runtime signals yet (heap floor, blocking routes, startup time). They need
            <span className="mono"> @abigaail/node</span> from chunk 10 and an Abigaail server that announces them; restarts and RSS are still judged.
          </p>
        </section>
      ) : null}

      <section className={v.signals ? "first" : undefined}>
        <h2>Open findings</h2>
        {v.findings.length ? (
          <ul className="plain">
            {v.findings.map((f) => (
              <li key={f.id} style={{ display: "block" }}>
                <Severity severity={f.severity} /> <span>{f.summary}</span>
                {f.cause ? <div className="small muted">{f.cause}</div> : null}
                <div className="small muted">{f.action}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No restart loop, leak, blocking route or slow start right now.</p>
        )}
      </section>

      <section>
        <h2>Memory, last 24 hours</h2>
        {hasMemory ? (
          <>
            <MemoryChart points={v.memory} boots={v.boots} limitMb={v.heapLimitMb} />
            <div className="legend">
              <span className="key"><i className="k-line" />heap floor after GC</span>
              <span className="key"><i className="k-line2" />RSS</span>
              <span className="key"><i className="k-line3" />external (Buffers)</span>
              <span className="key"><i className="k-boot" />process start</span>
            </div>
            <p className="small muted">
              Lowest reading per 15 minutes. A leak is a floor that keeps rising for hours within one process, not memory that is
              merely high; a restart resets it.
              {v.heapLimitMb !== null ? ` Heap limit ${mb(v.heapLimitMb)}.` : ""}
              {v.memoryLimitMb !== null ? ` Container limit ${mb(v.memoryLimitMb)}.` : ""}
            </p>
            {v.leaks.length ? (
              <ul className="plain">
                {v.leaks.map((l) => (
                  <li key={l.kind} style={{ display: "block" }}>
                    <span>{LEAK_LABEL[l.kind]}</span>
                    <div className="small muted num">
                      {mb(l.first_mb)} → {mb(l.last_mb)} since the start, +{l.mb_per_hour} MB/h
                      {l.hours_to_limit !== null ? ` · reaches the limit in about ${l.hours_to_limit} h` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <details className="table">
              <summary>Show as a table</summary>
              <table>
                <thead><tr><th>From (UTC)</th><th className="r">Heap floor</th><th className="r">RSS</th><th className="r">External</th></tr></thead>
                <tbody>
                  {v.memory.filter((p) => p.heapFloor !== null || p.rss !== null).map((p) => (
                    <tr key={p.t}>
                      <td>{when(p.t)}</td>
                      <td className="r">{mb(p.heapFloor)}</td>
                      <td className="r">{mb(p.rss)}</td>
                      <td className="r">{mb(p.external)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        ) : (
          <p className="empty">No memory readings in the last day.</p>
        )}
      </section>

      <div className="cols">
        <section>
          <h2>Event-loop blocks, last 24 hours</h2>
          {v.blocks24h.length ? (
            <ul className="plain">
              {v.blocks24h.map((b) => {
                const now15 = v.blockingNow.find((x) => x.route === b.route);
                return (
                  <li key={b.route ?? "(none)"} style={{ display: "block" }}>
                    {b.route ? <span className="mono">{b.route}</span> : <span className="muted">no request in flight</span>}
                    {now15 ? <span className="small red-text"> blocking now</span> : null}
                    <div className="small muted num">
                      {b.blocks} block{b.blocks === 1 ? "" : "s"} · {ms(b.blocked_ms)} in all · longest {ms(b.max_ms)}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty">No blocks of 100 ms or more.</p>
          )}
          <p className="small muted">The SDK charges a block to the request that ran through it and finished with it; long-open streams are never charged.</p>
        </section>

        <section>
          <h2>Restarts, last 24 hours</h2>
          {v.crashes.length ? (
            <ul className="plain">
              {v.crashes.map((c) => (
                <li key={`${c.ts}${c.instance ?? ""}`} style={{ display: "block" }}>
                  <div className="small faint">{when(c.ts)} · <span className="mono">{c.release}</span>{c.replaced ? " · a new instance took over" : ""}</div>
                  <div>{c.text[0]!.toUpperCase() + c.text.slice(1)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No restart without a clean shutdown.</p>
          )}
        </section>

        <section>
          <h2>Startup</h2>
          {v.startups.length ? (
            <>
              <ul className="plain">
                {v.startups.slice(0, 8).map((st) => (
                  <li key={st.ts} style={{ display: "block" }}>
                    <div className="small faint">{when(st.ts)} · <span className="mono">{st.release}</span></div>
                    <div className="num">{ms(st.startup_ms)}</div>
                  </li>
                ))}
              </ul>
              <p className="small muted">{v.usualStartupMs !== null ? `Usually ${ms(v.usualStartupMs)}.` : "No usual startup time yet."} From process start until the first server listened.</p>
            </>
          ) : (
            <p className="empty">No start with a startup time in the last day.</p>
          )}
        </section>
      </div>
    </main>
  );
}
