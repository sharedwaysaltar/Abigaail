// The channels against real receivers on 127.0.0.1: webhook formats and
// signature, SMTP with required STARTTLS and verified certificates, the
// heartbeat, and ingest staying fast while every channel hangs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Alerter, checkUrl, emailChannel, Heartbeat, sendTestAlert, testMessage, verifySignature, webhookChannel,
  type AlertMessage, type EmailConfig,
} from "@abigaail/server";
import { openStore, type Store } from "@abigaail/store";
import { batch, requestEvent, startServer, T0, type TestServer } from "./helpers.js";
import { emit, receiver, smtpServer, TEST_CERT } from "./alertfx.js";

const MIN = 60_000;
const SECRET = "test-secret-test-secret-test-secret-42";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const message = (): AlertMessage => testMessage(new URL("https://dash.example"), T0, "delivery-1");

describe("webhook", () => {
  it("posts the JSON message, signed, and a 2xx is a delivery", async () => {
    const r = await receiver();
    closers.push(r.close);
    const ch = webhookChannel({ url: checkUrl(r.url), secret: SECRET, format: "json", allowPrivate: false }, { now: () => T0 });
    expect(await ch.send(message())).toEqual({ ok: true, code: 204 });
    const [got] = r.got;
    expect(got!.method).toBe("POST");
    expect(got!.headers["content-type"]).toBe("application/json");
    expect(got!.headers["x-abigaail-delivery"]).toBe("delivery-1");
    expect(verifySignature(String(got!.headers["x-abigaail-signature"]), got!.body, SECRET, T0)).toBe(true);
    const body = JSON.parse(got!.body) as AlertMessage & { text: string };
    expect(body).toMatchObject({ version: 1, kind: "test", delivery_id: "delivery-1", items: [{ app: "example-app", link: "https://dash.example/alerts" }] });
    expect(body.text).toContain("This is a test alert from Abigaail");
  });

  it("ntfy gets plain text with a title, priority and tags", async () => {
    const r = await receiver();
    closers.push(r.close);
    const ch = webhookChannel({ url: checkUrl(r.url), secret: SECRET, format: "ntfy", allowPrivate: false });
    await ch.send(message());
    expect(r.got[0]!.headers).toMatchObject({ "content-type": "text/plain; charset=utf-8", title: "Abigaail test alert", priority: "default", tags: "test_tube" });
    expect(r.got[0]!.body).toContain("Nothing is wrong.");
  });

  it("a hanging receiver times out; an error status is a failure with its code", async () => {
    const r = await receiver({ current: "hang" });
    closers.push(r.close);
    const ch = webhookChannel({ url: checkUrl(r.url), secret: SECRET, format: "json", allowPrivate: false }, { timeoutMs: 200 });
    const started = Date.now();
    expect(await ch.send(message())).toEqual({ ok: false, error: "Timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
    r.mode.current = 429;
    expect(await ch.send(message())).toEqual({ ok: false, code: 429, error: "HttpStatus" });
  });
});

describe("email (nodemailer, STARTTLS required)", () => {
  const cfg = (port: number, o: Partial<EmailConfig> = {}): EmailConfig => ({
    host: "localhost", port, secure: false, user: "secret-user", password: "secret-password-123", from: "abigaail@example.com", to: ["owner@example.com"], ...o,
  });

  it("upgrades with STARTTLS, verifies the certificate, authenticates, and sends plain text", async () => {
    const smtp = await smtpServer();
    closers.push(smtp.close);
    const ch = emailChannel(cfg(smtp.port), { ca: TEST_CERT, timeoutMs: 5000 });
    expect(ch.label).toBe(`email via localhost:${smtp.port} to 1 recipient`);
    expect(await ch.send(message())).toEqual({ ok: true });
    const [m] = smtp.messages;
    expect(m!.tls).toBe(true);
    expect(m!.auth).not.toBeNull();
    expect(m!.data).toContain("Subject: Abigaail test alert");
    expect(m!.data).toContain("X-Abigaail-Delivery: delivery-1");
    expect(m!.data).toMatch(/Content-Type: text\/plain/i);
    expect(m!.data).toContain("Nothing is wrong.");
  });

  it("refuses to send when the server does not offer STARTTLS: no credentials, no message", async () => {
    const smtp = await smtpServer({ starttls: false });
    closers.push(smtp.close);
    const r = await emailChannel(cfg(smtp.port), { ca: TEST_CERT, timeoutMs: 5000 }).send(message());
    expect(r).toMatchObject({ ok: false, error: "ETLS" });
    expect(smtp.commands).not.toContain("AUTH");
    expect(smtp.commands).not.toContain("MAIL");
    expect(smtp.messages).toEqual([]);
  });

  it("refuses a certificate it cannot verify", async () => {
    const smtp = await smtpServer();
    closers.push(smtp.close);
    // Without the test CA the self-signed certificate is not trusted.
    const r = await emailChannel(cfg(smtp.port), { timeoutMs: 5000 }).send(message());
    expect(r.ok).toBe(false);
    expect(smtp.commands).not.toContain("AUTH");
    expect(smtp.messages).toEqual([]);
  });

  it("an auth failure and a server that hangs are failures with a code, never the server's text", async () => {
    const reject = await smtpServer({ rejectAuth: true });
    closers.push(reject.close);
    const r = await emailChannel(cfg(reject.port), { ca: TEST_CERT, timeoutMs: 5000 }).send(message());
    expect(r).toEqual({ ok: false, error: "EAUTH", code: 535 });
    expect(JSON.stringify(r)).not.toContain("secret-user");

    const hang = await smtpServer({ hangAt: "data" });
    closers.push(hang.close);
    const started = Date.now();
    const h = await emailChannel(cfg(hang.port), { ca: TEST_CERT, timeoutMs: 600 }).send(message());
    expect(h.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("alerts:test", () => {
  it("sends one sample through each channel, records it as a test and audits it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abigaail-alerttest-"));
    const store: Store = openStore(join(dir, "t.db"));
    closers.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const r = await receiver();
    closers.push(r.close);
    const smtp = await smtpServer({ rejectAuth: true });
    closers.push(smtp.close);
    const web = webhookChannel({ url: checkUrl(r.url), secret: SECRET, format: "json", allowPrivate: false });
    const mail = emailChannel({ host: "localhost", port: smtp.port, secure: false, user: "u", password: "p", from: "a@example.com", to: ["b@example.com"] }, { ca: TEST_CERT });
    store.writeAlertChannels([web, mail].map((c) => ({ channel: c.name, label: c.label })));
    const out = await sendTestAlert(store, [web, mail]);
    expect(out).toEqual([{ channel: "webhook", result: { ok: true, code: 204 } }, { channel: "email", result: { ok: false, error: "EAUTH", code: 535 } }]);
    expect(store.recentDeliveries().map((d) => [d.channel, d.kind, d.status, d.attempts])).toEqual([["email", "test", "gave_up", 1], ["webhook", "test", "delivered", 1]]);
    expect(store.listAudit(1)[0]).toMatchObject({ actor: "cli", action: "alerts.test" });
  });
});

describe("heartbeat", () => {
  it("pings while healthy, not while unhealthy; a failure is logged once, without the URL", async () => {
    const r = await receiver();
    closers.push(r.close);
    let healthy = true;
    const logs: string[] = [];
    const url = checkUrl(`${r.url}/ping-SECRETUUID`);
    const hb = new Heartbeat({ url, healthy: () => healthy, timeoutMs: 300, log: (m) => logs.push(m) });
    expect(await hb.beat()).toEqual({ ok: true, code: 204 });
    expect(r.got.map((g) => [g.method, g.url])).toEqual([["GET", "/hook/ping-SECRETUUID"]]);
    healthy = false;
    expect(await hb.beat()).toBeUndefined();
    expect(r.got).toHaveLength(1);
    healthy = true;
    r.mode.current = "hang";
    await hb.beat();
    await hb.beat();
    r.mode.current = "ok";
    await hb.beat();
    expect(logs).toEqual(["heartbeat: ping failed (Timeout)", "heartbeat: ping works again"]);
    for (const l of logs) expect(l).not.toContain("SECRETUUID");
  });
});

describe("ingest is unaffected when every channel hangs", () => {
  let s: TestServer;

  it("batches are answered quickly while the webhook and SMTP server never answer", async () => {
    s = await startServer();
    closers.push(() => s.close());
    const { key } = s.store.createApp("busy", "test");
    const appId = s.store.appByName("busy")!.id;
    const hook = await receiver({ current: "hang" });
    closers.push(hook.close);
    const smtp = await smtpServer({ hangAt: "greeting" });
    closers.push(smtp.close);
    const web = webhookChannel({ url: checkUrl(hook.url), secret: SECRET, format: "json", allowPrivate: false }, { timeoutMs: 1500 });
    const mail = emailChannel({ host: "localhost", port: smtp.port, secure: false, from: "a@example.com", to: ["b@example.com"] }, { ca: TEST_CERT, timeoutMs: 1500 });
    s.store.writeAlertChannels([web, mail].map((c) => ({ channel: c.name, label: c.label })));
    const a = new Alerter({ store: s.store, channels: [web, mail], now: () => s.clock.now, log: () => {}, limits: { retryDelaysMs: [50, 50] } });
    closers.push(() => a.stop());
    // A red finding, so both channels start sending (and hang).
    for (let i = 0; i < 2; i++) {
      s.clock.now += MIN;
      emit(s.store, s.clock.now, appId, [{ signal: "server_errors", subject: "/x", severity: "critical" }]);
    }
    a.sweep();

    const timings: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      const res = await fetch(`${s.url}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-abigaail-key": key },
        body: JSON.stringify(batch([requestEvent({ client_ts: s.clock.now })])),
      });
      expect(res.status).toBe(202);
      timings.push(performance.now() - started);
    }
    timings.sort((x, y) => x - y);
    // While both sends hang, ingest answers at its usual speed.
    expect(timings[Math.floor(timings.length * 0.95)]!).toBeLessThan(250);
    expect(s.store.recentDeliveries().every((d) => d.status === "pending")).toBe(true);

    // The channels time out, retry with backoff and give up; nothing is left hanging.
    const end = Date.now() + 15_000;
    while (s.store.recentDeliveries().some((d) => d.status === "pending") && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    // (nodemailer's own greeting timeout, ETIMEDOUT, may fire before the channel's overall one.)
    expect(s.store.recentDeliveries().map((d) => [d.channel, d.status, d.attempts, d.last_error]).sort()).toEqual([
      ["email", "gave_up", 3, expect.stringMatching(/^(Timeout|ETIMEDOUT)$/)],
      ["webhook", "gave_up", 3, "Timeout"],
    ]);
  }, 30_000);
});
