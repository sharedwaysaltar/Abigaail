import { alertsView, type DeliveryView } from "@abigaail/insights";
import type { AlertChannelRow } from "@abigaail/store";
import { Status } from "@/components/Status";
import { reader } from "@/lib/data";
import { ago, when } from "@/lib/format";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const OUTCOME: Record<DeliveryView["status"], string> = {
  delivered: "Delivered",
  pending: "Sending",
  gave_up: "Not delivered",
  suppressed: "Not sent (hourly cap)",
};

const KIND: Record<DeliveryView["kind"], string> = { alert: "Alert", storm: "Alert (storm notice)", test: "Test" };

function ChannelRow({ c, now }: { c: AlertChannelRow; now: number }) {
  const failing = c.fail_streak > 0;
  return (
    <tr>
      <td>{c.label}</td>
      <td>
        <Status status={failing ? (c.fail_streak >= 3 ? "red" : "amber") : c.last_ok_at !== null ? "green" : "grey"} label={false} />{" "}
        {failing ? `${c.fail_streak} failed attempt${c.fail_streak === 1 ? "" : "s"} in a row (${c.last_error ?? "error"})` : c.last_ok_at !== null ? "Working" : "Nothing sent yet"}
      </td>
      <td>{c.last_ok_at !== null ? ago(c.last_ok_at, now) : "—"}</td>
      <td>{c.last_failed_at !== null ? ago(c.last_failed_at, now) : "—"}</td>
    </tr>
  );
}

export default async function AlertsPage() {
  await requireSession();
  const r = reader();
  const now = Date.now();
  const { channels, deliveries } = alertsView(r, r.listApps());

  return (
    <main>
      <div className="hero">
        <h1>Alerts</h1>
        <p>
          Only findings confirmed red (critical in 2 runs in a row) are sent, once, with one notice when they resolve.
          Sent by the server, so alerts work with the dashboard down.
        </p>
      </div>

      <section className="first">
        <h2>Channels</h2>
        {channels.length ? (
          <>
            <table>
              <thead><tr><th>Channel</th><th>State</th><th>Last delivered</th><th>Last failed</th></tr></thead>
              <tbody>{channels.map((c) => <ChannelRow key={c.channel} c={c} now={now} />)}</tbody>
            </table>
            <p className="small muted">
              {channels.length === 1
                ? "Only one channel is configured: if it keeps failing, you are told here and in Findings only, because the broken channel cannot report itself. Add a second channel to be told elsewhere."
                : "If one channel keeps failing (3 attempts in a row), the Watchdog's alert_delivery_failed is sent through the other."}
              {" "}Settings live on the server (ABIGAAIL_ALERT_WEBHOOK_*, ABIGAAIL_SMTP_*); run <span className="mono">npm run alerts:test</span> to send a sample.
            </p>
          </>
        ) : (
          <p className="empty">
            Alerts are off: no channel is configured on the server. Set ABIGAAIL_ALERT_WEBHOOK_URL or ABIGAAIL_SMTP_HOST (see the README, Alerts) and restart it.
          </p>
        )}
      </section>

      <section>
        <h2>Sent</h2>
        {deliveries.length ? (
          <table>
            <thead><tr><th>When (UTC)</th><th>Channel</th><th>What</th><th>Outcome</th><th className="r">Attempts</th></tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{when(d.created_at)}</td>
                  <td className="mono">{d.channel}</td>
                  <td>
                    {KIND[d.kind]}
                    {d.items.length ? (
                      <ul className="plain small muted">
                        {d.items.map((i, n) => (
                          <li key={n} style={{ display: "block" }}>
                            {i.change === "firing" ? "Red" : "Resolved"} · {i.app} · <span className="mono">{i.fingerprint}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className={d.status === "gave_up" ? "red-text" : undefined}>
                    {OUTCOME[d.status]}
                    {d.status !== "delivered" && d.last_error ? ` (${d.last_error}${d.last_code !== null ? ` ${d.last_code}` : ""})` : ""}
                    {d.status === "pending" && d.next_attempt_at !== null && d.attempts ? `, next try ${when(d.next_attempt_at)}` : ""}
                  </td>
                  <td className="r">{d.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">Nothing sent yet.</p>
        )}
      </section>
    </main>
  );
}
