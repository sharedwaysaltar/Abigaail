// Alerts (DECISIONS #95-#99): who is told what, when, and only once.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Alerter, evaluate, ITEM_FIELDS, subject, text, verifySignature, watchdog, webhookChannel, webhookRequest, WEBHOOK_FORMATS,
  type AlerterOptions, type AlertMessage, type Channel, type SendResult,
} from "@abigaail/server";
import { openStore, type Store } from "@abigaail/store";
import { emit, receiver, recordingChannel } from "./alertfx.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
let clock = T0;
let dir: string;
let dbPath: string;
let store: Store;
let appId: string;

beforeEach(() => {
  clock = T0;
  dir = mkdtempSync(join(tmpdir(), "abigaail-alerts-"));
  dbPath = join(dir, "test.db");
  store = openStore(dbPath, { now: () => clock });
  appId = store.createApp("shop", "test").app.id;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const QUIET_LOG = () => {};

function alerter(channels: Channel[], o: Partial<AlerterOptions> = {}): Alerter {
  store.writeAlertChannels(channels.map((c) => ({ channel: c.name, label: c.label })));
  return new Alerter({ store, channels, now: () => clock, log: QUIET_LOG, dashboardUrl: new URL("https://dash.example/"), ...o });
}

/** Advance one minute, let Health emit these findings, then sweep and wait for the sends. */
async function minute(a: Alerter, findings: Parameters<typeof emit>[3], scope: string | null = appId, agent = "health"): Promise<void> {
  clock += MIN;
  emit(store, clock, scope, findings, agent);
  a.sweep();
  await a.idle();
}

const red = (subject = "/checkout") => ({ signal: "server_errors", subject, severity: "critical" as const });
const statusOf = () => store.appStatus(appId, { now: clock, freshMs: 10 * MIN }).status;

describe("when an alert is sent", () => {
  it("a single critical hit never notifies, the second in a row does (and only then is the app red)", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    await minute(a, [red()]);
    expect(sent).toEqual([]);
    expect(statusOf()).toBe("amber");
    await minute(a, [red()]);
    expect(statusOf()).toBe("red");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.items).toMatchObject([{ app: "shop", change: "firing", severity: "critical", signal: "server_errors" }]);
    // Still red: nothing more.
    await minute(a, [red()]);
    expect(sent).toHaveLength(1);
    // Each sweep is logged, so the Watchdog sees a stalled alerter.
    expect(store.recentRuns("alerts").map((r) => r.outcome)).toEqual(["ok", "ok", "ok"]);
  });

  it("a warning that turns critical needs 2 runs at critical, not 2 runs in all", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    await minute(a, [{ ...red(), severity: "warning" }]);
    await minute(a, [red()]);
    // hits = 2, but only one of them critical: amber, no alert.
    expect(store.openFindings(appId)[0]).toMatchObject({ hits: 2, critical_streak: 1 });
    expect(statusOf()).toBe("amber");
    expect(sent).toEqual([]);
    await minute(a, [red()]);
    expect(sent).toHaveLength(1);
  });

  it("warnings, unknown and info never alert", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    for (let i = 0; i < 5; i++) {
      await minute(a, [
        { signal: "latency", subject: "/a", severity: "warning" },
        { signal: "no_data", subject: "", severity: "unknown" },
        { signal: "deploy", subject: "r1", severity: "info" },
      ]);
    }
    expect(sent).toEqual([]);
  });

  it("one recovery notice when it resolves; a downgrade to warning sends nothing", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    await minute(a, [red()]);
    await minute(a, [red()]);
    await minute(a, [{ ...red(), severity: "warning" }]);
    await minute(a, [{ ...red(), severity: "warning" }]);
    expect(sent.map((m) => m.items[0]!.change)).toEqual(["firing"]);
    // Three runs without it: resolved.
    for (let i = 0; i < 3; i++) await minute(a, []);
    expect(store.openFindings(appId)).toEqual([]);
    expect(sent.map((m) => m.items[0]!.change)).toEqual(["firing", "recovered"]);
    // First seen at minute 1, resolved at minute 7 (third run without it).
    expect(text(sent[1]!)).toContain("shop: resolved after 6 min");
    for (let i = 0; i < 3; i++) await minute(a, []);
    expect(sent).toHaveLength(2);
  });

  it("Abigaail's own critical findings alert too, named Abigaail", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    await minute(a, [{ signal: "salt_rotation_failed", severity: "critical" }], null, "watchdog");
    await minute(a, [{ signal: "salt_rotation_failed", severity: "critical" }], null, "watchdog");
    expect(sent[0]!.items).toMatchObject([{ app: "Abigaail", signal: "salt_rotation_failed" }]);
    expect(sent[0]!.items[0]!.link).toMatch(/^https:\/\/dash\.example\/findings#finding-\d+$/);
  });
});

describe("no duplicates", () => {
  it("a restart does not send again; without the persisted state it would", async () => {
    const first = recordingChannel("webhook");
    const a = alerter([first.channel]);
    await minute(a, [red()]);
    await minute(a, [red()]);
    expect(first.sent).toHaveLength(1);
    a.stop();

    const second = recordingChannel("webhook");
    const b = alerter([second.channel]);
    b.resume();
    await minute(b, [red()]);
    expect(second.sent).toEqual([]);

    // Control: the persisted alert_state is what stops the resend.
    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM alert_state");
    db.close();
    await minute(b, [red()]);
    expect(second.sent).toHaveLength(1);
  });

  it("a flapping finding sends at most one firing message per 30 min, then one catch-up", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    // Red for 2 runs, gone for 3 (resolves), again and again for an hour.
    const cycle = [[red()], [red()], [], [], []];
    for (let i = 0; i < 60; i++) await minute(a, cycle[i % cycle.length]!);
    const firing = sent.filter((m) => m.items[0]!.change === "firing");
    const recovered = sent.filter((m) => m.items[0]!.change === "recovered");
    // Without the cooldown this would be 12 firing and 12 recovered messages.
    expect(firing.length).toBeLessThanOrEqual(3);
    expect(recovered.length).toBeLessThanOrEqual(firing.length);
    const firedAt = firing.map((m) => m.created_at);
    for (let i = 1; i < firedAt.length; i++) expect(firedAt[i]! - firedAt[i - 1]!).toBeGreaterThanOrEqual(30 * MIN);
    // The catch-up says it changed in between.
    expect(firing[1]!.items[0]!.flaps).toBeGreaterThan(0);
    expect(text(firing[1]!)).toMatch(/changed \d+ more times since the last message/);
  });

  it("many findings at once go out as one message per channel", async () => {
    const web = recordingChannel("webhook");
    const mail = recordingChannel("email");
    const a = alerter([web.channel, mail.channel]);
    const other = store.createApp("blog", "test").app.id;
    const many = Array.from({ length: 12 }, (_, i) => red(`/r${i}`));
    for (let i = 0; i < 2; i++) {
      clock += MIN;
      emit(store, clock, appId, many);
      emit(store, clock + 1, other, many.slice(0, 8));
      a.sweep();
      await a.idle();
    }
    for (const ch of [web, mail]) {
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.items).toHaveLength(10);
      expect(ch.sent[0]!.more).toBe(10);
      expect(new Set(ch.sent[0]!.items.map((i) => i.app))).toEqual(new Set(["blog", "shop"]));
      expect(text(ch.sent[0]!)).toContain("and 10 more on the dashboard");
    }
    // Every finding is recorded against its app, all 20 of them.
    expect(store.alertItems(appId, 0)).toHaveLength(24);
    expect(store.alertItems(other, 0)).toHaveLength(16);
  });

  it("past the hourly cap a channel gets one storm message, then the rest only on the dashboard", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel], { limits: { perChannelPerHour: 2 } });
    for (let i = 0; i < 5; i++) {
      await minute(a, [red(`/s${i}`)]);
      await minute(a, [red(`/s${i}`)]);
    }
    expect(sent.map((m) => m.kind)).toEqual(["alert", "alert", "storm"]);
    expect(text(sent[2]!)).toContain("alert storm");
    // Recoveries count too; everything after the storm message is recorded, not sent.
    const statuses = store.recentDeliveries().map((d) => d.status).reverse();
    expect(statuses.slice(0, 3)).toEqual(["delivered", "delivered", "delivered"]);
    expect(statuses.length).toBeGreaterThan(3);
    expect(new Set(statuses.slice(3))).toEqual(new Set(["suppressed"]));
  });

  it("a finding closed as not observed during downtime: no resend if it is red again, one 'no longer seen' notice if not", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    await minute(a, [red("/a"), red("/b")]);
    await minute(a, [red("/a"), red("/b")]);
    expect(sent).toHaveLength(1);
    // Abigaail was down for an hour; the runner closes Health's findings as not observed.
    clock += 60 * MIN;
    store.resolveUnobserved("health", clock);
    // /a is still failing and comes back red; /b does not come back.
    await minute(a, [red("/a")]);
    await minute(a, [red("/a")]);
    expect(sent).toHaveLength(1);
    await minute(a, [red("/a")]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.items).toMatchObject([{ change: "recovered", not_observed: true }]);
    expect(text(sent[1]!)).toContain("no longer seen after Abigaail restarted");
    expect(sent[1]!.items[0]!.summary).toContain("/b");
  });
});

describe("delivery", () => {
  async function until(check: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(5);
    }
  }

  it("retries with backoff, then gives up cleanly; attempts and the failure streak are recorded", async () => {
    const logs: string[] = [];
    const { channel, sent } = recordingChannel("webhook", { next: () => ({ ok: false, error: "HttpStatus", code: 503 }) });
    const a = alerter([channel], { limits: { retryDelaysMs: [5, 10, 20] }, log: (m) => logs.push(m) });
    await minute(a, [red()]);
    await minute(a, [red()]);
    await until(() => store.recentDeliveries()[0]!.status === "gave_up");
    expect(sent).toHaveLength(4);
    expect(store.recentDeliveries()[0]).toMatchObject({ attempts: 4, last_error: "HttpStatus", last_code: 503 });
    expect(store.alertChannels()[0]).toMatchObject({ fail_streak: 4, last_error: "HttpStatus" });
    expect(logs.at(-1)).toBe("alerts: webhook message given up after 4 attempts (HttpStatus 503)");
    // Given up means given up: a later sweep does not send it again.
    await minute(a, [red()]);
    await sleep(40);
    expect(sent).toHaveLength(4);
  });

  it("a success resets the channel's failure streak", async () => {
    let fail = 2;
    const { channel } = recordingChannel("webhook", { next: () => (fail-- > 0 ? { ok: false, error: "Timeout" } : { ok: true, code: 204 }) });
    const a = alerter([channel], { limits: { retryDelaysMs: [5, 5, 5] } });
    await minute(a, [red()]);
    await minute(a, [red()]);
    await until(() => store.recentDeliveries()[0]!.status === "delivered");
    expect(store.recentDeliveries()[0]!.attempts).toBe(3);
    expect(store.alertChannels()[0]).toMatchObject({ fail_streak: 0, last_error: "Timeout" });
  });

  it("the queue is bounded: past it the oldest waiting message is given up", async () => {
    let release: (r: SendResult) => void = () => {};
    const hanging: Channel = { name: "webhook", label: "webhook (test)", send: () => new Promise((r) => (release = r)) };
    const a = alerter([hanging], { limits: { queueMax: 2 } });
    for (let i = 0; i < 5; i++) {
      clock += MIN;
      emit(store, clock, appId, [red(`/q${i}`)]);
      clock += MIN;
      emit(store, clock, appId, [red(`/q${i}`)]);
      a.sweep();
    }
    // One in flight, two waiting, two given up.
    expect(store.recentDeliveries().map((d) => d.status).sort()).toEqual(["gave_up", "gave_up", "pending", "pending", "pending"]);
    expect(store.recentDeliveries().filter((d) => d.status === "gave_up").every((d) => d.last_error === "QueueFull")).toBe(true);
    release({ ok: true });
    a.stop();
  });

  it("after a restart, a recent pending message is resumed and a stale one given up", async () => {
    const message = (id: string): AlertMessage => ({ version: 1, delivery_id: id, kind: "alert", created_at: clock, items: [], more: 0 });
    const old = store.applyAlerts([], [{ delivery_id: "old", channel: "webhook", kind: "alert", payload: JSON.stringify(message("old")), status: "pending", items: [] }]);
    clock += 40 * MIN;
    store.applyAlerts([], [{ delivery_id: "new", channel: "webhook", kind: "alert", payload: JSON.stringify(message("new")), status: "pending", items: [] }]);
    store.applyAlerts([], [{ delivery_id: "gone", channel: "email", kind: "alert", payload: JSON.stringify(message("gone")), status: "pending", items: [] }]);
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    a.resume();
    await a.idle();
    expect(sent.map((m) => m.delivery_id)).toEqual(["new"]);
    const byId = new Map(store.recentDeliveries().map((d) => [d.delivery_id, d]));
    expect(byId.get("old")).toMatchObject({ id: old[0], status: "gave_up", last_error: "Expired", attempts: 0 });
    expect(byId.get("gone")).toMatchObject({ status: "gave_up", last_error: "ChannelRemoved" });
    expect(byId.get("new")).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("alert_delivery_failed about one channel goes through the other only; with one channel, nowhere", async () => {
    const web = recordingChannel("webhook");
    const mail = recordingChannel("email");
    const a = alerter([web.channel, mail.channel]);
    const failed = { signal: "alert_delivery_failed", subject: "webhook", severity: "critical" as const };
    await minute(a, [failed], null, "watchdog");
    await minute(a, [failed], null, "watchdog");
    expect(web.sent).toEqual([]);
    expect(mail.sent[0]!.items).toMatchObject([{ app: "Abigaail", signal: "alert_delivery_failed" }]);

    a.stop();
    const only = recordingChannel("webhook");
    const b = alerter([only.channel]);
    for (let i = 0; i < 3; i++) await minute(b, [], null, "watchdog");
    await minute(b, [failed], null, "watchdog");
    await minute(b, [failed], null, "watchdog");
    expect(only.sent).toEqual([]);
  });

  it("the Watchdog raises alert_delivery_failed after 3 failed attempts in a row, and it resolves on a success", () => {
    store.writeAlertChannels([{ channel: "webhook", label: "webhook (json, hooks.example)" }, { channel: "email", label: "email via smtp.example:587 to 1 recipient" }]);
    const [d] = store.applyAlerts([], [{ delivery_id: "x", channel: "webhook", kind: "alert", payload: "{}", status: "pending", items: [] }]);
    const run = () =>
      evaluate(watchdog, {
        store, apps: store.listApps(), now: clock, windowEnd: clock,
        config: { dbPath, schedules: [], runnerStartedAt: clock - 60 * MIN, lastRunBeforeStart: null },
      }).findings.filter((f) => f.signal === "alert_delivery_failed");
    for (let i = 0; i < 2; i++) store.recordAttempt(d!, "webhook", { ok: false, error: "ECONNREFUSED", retryAt: clock + MIN });
    expect(run()).toEqual([]);
    store.recordAttempt(d!, "webhook", { ok: false, error: "ECONNREFUSED", retryAt: clock + MIN });
    const [f] = run();
    expect(f).toMatchObject({ subject: "webhook", severity: "critical", fact: true });
    expect(f!.summary).toContain("webhook (json, hooks.example) are not getting through: 3 attempts in a row failed (last: ECONNREFUSED)");
    expect(f!.cause).toContain("sent through the other channel");
    store.recordAttempt(d!, "webhook", { ok: true, code: 204 });
    expect(run()).toEqual([]);
  });
});

describe("what an alert says", () => {
  it("items carry exactly the allowlisted fields: evidence never leaves Abigaail", async () => {
    const { channel, sent } = recordingChannel("webhook");
    const a = alerter([channel]);
    const planted = { ...red(), evidence: { marker: "PLANTED-EVIDENCE-7f3a", visitor_hash: "PLANTED-HASH-91bc" } };
    await minute(a, [planted]);
    await minute(a, [planted]);
    const m = sent[0]!;
    expect(Object.keys(m.items[0]!).sort()).toEqual([...ITEM_FIELDS].sort());
    const rendered = [JSON.stringify(m), subject(m), text(m), ...WEBHOOK_FORMATS.map((f) => JSON.stringify(webhookRequest(m, f, "s".repeat(32), clock)))];
    // The stored payload too (what a restart would resend).
    rendered.push(...new DatabaseSync(dbPath, { readOnly: true }).prepare("SELECT payload FROM alert_deliveries").all().map((r) => String((r as { payload: string }).payload)));
    for (const r of rendered) {
      expect(r).not.toContain("PLANTED-EVIDENCE-7f3a");
      expect(r).not.toContain("PLANTED-HASH-91bc");
    }
    // Control: the evidence was really there to leak.
    expect(JSON.stringify(store.openFindings(appId)[0]!.evidence)).toContain("PLANTED-EVIDENCE-7f3a");
  });

  it("is signed: the receiver can verify it, and a changed body, timestamp or secret fails", () => {
    const secret = "k".repeat(40);
    const m: AlertMessage = { version: 1, delivery_id: "d1", kind: "alert", created_at: clock, items: [], more: 0 };
    for (const format of WEBHOOK_FORMATS) {
      const { body, headers } = webhookRequest(m, format, secret, clock);
      const sig = headers["x-abigaail-signature"]!;
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(verifySignature(sig, body, secret, clock)).toBe(true);
      expect(verifySignature(sig, `${body} `, secret, clock)).toBe(false);
      expect(verifySignature(sig, body, secret, clock + 6 * MIN)).toBe(false);
      expect(verifySignature(sig, body, "x".repeat(40), clock)).toBe(false);
      expect(verifySignature(sig.replace(/t=\d+/, `t=${Math.floor(clock / 1000) + 1}`), body, secret, clock)).toBe(false);
    }
  });

  it("formats: Slack escapes, Discord stays under its limit with mentions off, ntfy headers are ASCII", () => {
    const item = {
      app: "shop", change: "firing" as const, severity: "critical" as const, signal: "x", summary: "<!channel> @everyone & /a 🔥", cause: null,
      action: "do", first_seen: clock, resolved_at: null, not_observed: false, flaps: 0, link: "https://dash.example/findings?app=shop#finding-1",
    };
    const m: AlertMessage = { version: 1, delivery_id: "d", kind: "alert", created_at: clock, items: Array(30).fill(item), more: 0 };
    const slack = JSON.parse(webhookRequest(m, "slack", "s".repeat(32), clock).body) as { text: string };
    expect(slack.text).toContain("&lt;!channel&gt;");
    expect(slack.text).not.toContain("<!channel>");
    const discord = JSON.parse(webhookRequest(m, "discord", "s".repeat(32), clock).body) as { content: string; allowed_mentions: unknown };
    expect(discord.content.length).toBeLessThanOrEqual(2000);
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    const ntfy = webhookRequest({ ...m, items: [item] }, "ntfy", "s".repeat(32), clock);
    expect(ntfy.headers).toMatchObject({ priority: "urgent", tags: "rotating_light", click: item.link });
    for (const v of Object.values(ntfy.headers)) expect(v).toMatch(/^[\x20-\x7e]*$/);
  });

  it("logs name the channel and an error code, never the URL, its path or the secret", async () => {
    const r = await receiver({ current: 500 });
    try {
      const logs: string[] = [];
      const url = new URL(`${r.url}/T0SECRETPATH`);
      const secret = "SECRETSECRETSECRETSECRETSECRET-123";
      const ch = webhookChannel({ url, secret, format: "slack", allowPrivate: false });
      expect(ch.label).toBe("webhook (slack, 127.0.0.1)");
      const a = alerter([ch], { limits: { retryDelaysMs: [5] }, log: (m) => logs.push(m) });
      await minute(a, [red()]);
      await minute(a, [red()]);
      await sleep(100);
      await a.idle();
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).not.toContain("T0SECRETPATH");
        expect(line).not.toContain(secret);
        expect(line).not.toContain(String(r.port));
      }
      expect(logs).toContain("alerts: webhook message given up after 2 attempts (HttpStatus 500)");
      expect(JSON.stringify(store.alertChannels())).not.toContain("T0SECRETPATH");
    } finally {
      await r.close();
    }
  });
});
