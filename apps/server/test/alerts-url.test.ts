// Where alerts and heartbeats may go (DECISIONS #96): https, or http only to
// this machine, never an internal service, checked as written and again at
// every connection. Settings that are set but invalid stop the server and
// name the variable, never its value.

import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { addressKind, checkUrl, loadAlertConfig, loadConfig, send, UrlRefused } from "@abigaail/server";
import { receiver } from "./alertfx.js";

describe("address kinds", () => {
  it.each([
    ["8.8.8.8", "public"], ["1.1.1.1", "public"], ["2606:4700::1111", "public"],
    ["127.0.0.1", "loopback"], ["127.9.9.9", "loopback"], ["::1", "loopback"], ["::ffff:127.0.0.1", "loopback"],
    ["10.1.2.3", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.1.1", "private"],
    ["100.64.0.1", "private"], ["100.127.255.254", "private"], ["fd12:3456::1", "private"], ["fc00::1", "private"],
    ["::ffff:10.0.0.1", "private"], ["64:ff9b::10.0.0.1", "private"],
    ["169.254.169.254", "link_local"], ["fe80::1", "link_local"], ["::ffff:169.254.169.254", "link_local"],
    ["0.0.0.0", "special"], ["::", "special"], ["224.0.0.1", "special"], ["255.255.255.255", "special"], ["240.0.0.1", "special"],
    ["ff02::1", "special"], ["2001:db8::1", "special"], ["::10.0.0.1", "special"], ["fec0::1", "special"],
    ["172.32.0.1", "public"], ["100.128.0.1", "public"], ["not-an-ip", "special"],
  ])("%s is %s", (ip, kind) => {
    expect(addressKind(ip)).toBe(kind);
  });
});

describe("checkUrl", () => {
  const refused = (raw: string, allowPrivate = false) => {
    try {
      checkUrl(raw, { allowPrivate });
    } catch (err) {
      expect(err).toBeInstanceOf(UrlRefused);
      // The reason never repeats the URL.
      expect((err as Error).message).not.toContain(raw);
      return (err as UrlRefused).reason;
    }
    throw new Error(`accepted ${raw}`);
  };

  it.each([
    "https://hooks.slack.com/services/T0/B0/xyz", "https://ntfy.sh/topic", "https://discord.com/api/webhooks/1/abc",
    "http://localhost:8080/hook", "http://127.0.0.1:2586/alerts", "http://[::1]:9000/", "https://localhost/hook",
  ])("accepts %s", (raw) => {
    expect(checkUrl(raw).href).toBe(new URL(raw).href);
  });

  it.each([
    ["http://ntfy.sh/topic", "plain http is allowed only to localhost"],
    ["ftp://example.com/x", "must be https (or http to localhost)"],
    ["file:///etc/passwd", "must be https (or http to localhost)"],
    ["https://user:pass@example.com/", "must not contain a user name or password"],
    ["https://169.254.169.254/latest/meta-data/", "link-local address"],
    ["https://[fe80::1]/", "link-local address"],
    ["https://0.0.0.0/", "special address"],
    ["https://[::]/", "special address"],
    ["https://224.0.0.1/", "special address"],
    ["http://app.localhost/", "plain http is allowed only to localhost"],
    ["https://app.localhost/", "*.localhost names are not allowed"],
    ["not a url", "not a URL"],
  ])("refuses %s", (raw, reason) => {
    expect(refused(raw)).toBe(reason);
  });

  it("refuses internal addresses however they are written", () => {
    // The URL parser normalises decimal, hex and short forms; the check sees the address.
    for (const raw of ["https://2852039166/", "https://0xa9.0xfe.0xa9.0xfe/", "https://[::ffff:169.254.169.254]/", "https://[::ffff:a9fe:a9fe]/"]) {
      expect(refused(raw)).toBe("link-local address");
    }
    for (const raw of ["https://167772161/", "https://10.1/", "https://[::ffff:10.0.0.1]/"]) {
      expect(refused(raw)).toMatch(/^private address/);
    }
  });

  it("private, CGNAT and ULA addresses only with the explicit opt-in; link-local and metadata never", () => {
    for (const raw of ["https://10.0.0.5/hook", "https://192.168.1.20:8443/", "https://100.101.102.103/", "https://[fd7a:115c:a1e0::1]/"]) {
      expect(refused(raw)).toBe("private address");
      expect(checkUrl(raw, { allowPrivate: true }).href).toBe(new URL(raw).href);
    }
    for (const raw of ["https://169.254.169.254/", "https://[fe80::1]/", "https://[::ffff:169.254.169.254]/", "https://0.0.0.0/"]) {
      expect(refused(raw, true)).toMatch(/link-local|special/);
    }
    // http stays localhost-only even with the opt-in.
    expect(refused("http://192.168.1.20/", true)).toBe("plain http is allowed only to localhost");
  });
});

describe("every connection is checked (DNS rebinding)", () => {
  const resolving = (addresses: LookupAddress[]) => (_h: string, _o: unknown, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => cb(null, addresses);
  const opts = { method: "POST" as const, body: "{}", timeoutMs: 2000, maxBytes: 4096 };

  it("a public name that resolves to an internal address is refused before connecting", async () => {
    const url = checkUrl("https://hooks.example.com/x");
    for (const address of ["10.0.0.1", "169.254.169.254", "127.0.0.1"]) {
      const r = await send(url, { ...opts, resolve: resolving([{ address, family: 4 }]) });
      expect(r).toEqual({ ok: false, error: "UrlRefused" });
    }
    // One bad address among good ones is enough to refuse.
    expect(await send(url, { ...opts, resolve: resolving([{ address: "93.184.215.14", family: 4 }, { address: "fd00::1", family: 6 }]) }))
      .toEqual({ ok: false, error: "UrlRefused" });
  });

  it("with the opt-in a private address is allowed, link-local still refused", async () => {
    const url = checkUrl("https://ntfy.home.example/alerts", { allowPrivate: true });
    expect(await send(url, { ...opts, policy: { allowPrivate: true }, resolve: resolving([{ address: "169.254.169.254", family: 4 }]) }))
      .toEqual({ ok: false, error: "UrlRefused" });
    // A private address passes the check and the connection is attempted (and refused by nobody listening there).
    const r = await send(url, { ...opts, timeoutMs: 300, policy: { allowPrivate: true }, resolve: resolving([{ address: "10.255.255.1", family: 4 }]) });
    expect(r.error).not.toBe("UrlRefused");
  });

  it("localhost must resolve to this machine", async () => {
    const r = await receiver();
    try {
      const url = checkUrl(`http://localhost:${r.port}/hook`);
      expect(await send(url, { ...opts, resolve: resolving([{ address: "93.184.215.14", family: 4 }]) })).toEqual({ ok: false, error: "UrlRefused" });
      expect(await send(url, { ...opts, resolve: resolving([{ address: "127.0.0.1", family: 4 }]) })).toEqual({ ok: true, code: 204 });
    } finally {
      await r.close();
    }
  });

  it("redirects are not followed", async () => {
    const r = await receiver({ current: "redirect" });
    try {
      expect(await send(checkUrl(r.url), opts)).toEqual({ ok: false, code: 302, error: "HttpStatus" });
      expect(r.got.map((g) => g.url)).toEqual(["/hook"]);
    } finally {
      await r.close();
    }
  });
});

describe("alert settings", () => {
  const SECRET = "s".repeat(32);
  const base = { ABIGAAIL_ALERT_WEBHOOK_URL: "https://ntfy.sh/abigaail-topic-SECRET", ABIGAAIL_ALERT_WEBHOOK_SECRET: SECRET };
  const fails = (env: Record<string, string>) => {
    try {
      loadAlertConfig(env);
    } catch (err) {
      const msg = (err as Error).message;
      for (const v of Object.values(env)) if (v.length > 3) expect(msg).not.toContain(v);
      return msg;
    }
    throw new Error("accepted");
  };

  it("nothing set: alerts are off", () => {
    expect(loadAlertConfig({})).toEqual({});
  });

  it("reads a webhook, an email list, the dashboard link and the heartbeat", () => {
    const c = loadAlertConfig({
      ...base, ABIGAAIL_ALERT_WEBHOOK_FORMAT: "NTFY",
      ABIGAAIL_SMTP_HOST: "smtp.example.com", ABIGAAIL_SMTP_USER: "u", ABIGAAIL_SMTP_PASSWORD: "p w",
      ABIGAAIL_ALERT_EMAIL_FROM: "abigaail@example.com", ABIGAAIL_ALERT_EMAIL_TO: "a@example.com, b@example.org",
      ABIGAAIL_DASHBOARD_URL: "http://localhost:4319", ABIGAAIL_HEARTBEAT_URL: "https://hc-ping.com/uuid",
    });
    expect(c.webhook).toMatchObject({ format: "ntfy", allowPrivate: false, secret: SECRET });
    expect(c.email).toEqual({ host: "smtp.example.com", port: 587, secure: false, user: "u", password: "p w", from: "abigaail@example.com", to: ["a@example.com", "b@example.org"] });
    expect(loadAlertConfig({ ABIGAAIL_SMTP_HOST: "smtp.example.com", ABIGAAIL_SMTP_PORT: "465", ABIGAAIL_ALERT_EMAIL_FROM: "a@example.com", ABIGAAIL_ALERT_EMAIL_TO: "b@example.com" }).email)
      .toMatchObject({ port: 465, secure: true });
    expect(c.dashboardUrl?.href).toBe("http://localhost:4319/");
    expect(c.heartbeatUrl?.href).toBe("https://hc-ping.com/uuid");
  });

  it.each([
    [{ ...base, ABIGAAIL_ALERT_WEBHOOK_URL: "http://ntfy.sh/topic-SECRET" }, "ABIGAAIL_ALERT_WEBHOOK_URL is not allowed: plain http is allowed only to localhost"],
    [{ ...base, ABIGAAIL_ALERT_WEBHOOK_URL: "https://10.0.0.9/topic-SECRET" }, "ABIGAAIL_ALERT_WEBHOOK_URL is not allowed: private address (set ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE=1"],
    [{ ...base, ABIGAAIL_ALERT_WEBHOOK_SECRET: "short" }, "ABIGAAIL_ALERT_WEBHOOK_SECRET must be at least 32 characters"],
    [{ ABIGAAIL_ALERT_WEBHOOK_URL: base.ABIGAAIL_ALERT_WEBHOOK_URL }, "ABIGAAIL_ALERT_WEBHOOK_SECRET must be at least 32 characters"],
    [{ ...base, ABIGAAIL_ALERT_WEBHOOK_FORMAT: "teams" }, "ABIGAAIL_ALERT_WEBHOOK_FORMAT must be one of json, slack, discord, ntfy"],
    [{ ...base, ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE: "yes" }, "ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE must be 1 or unset"],
    [{ ABIGAAIL_ALERT_WEBHOOK_SECRET: SECRET }, "ABIGAAIL_ALERT_WEBHOOK_SECRET is set but ABIGAAIL_ALERT_WEBHOOK_URL is not"],
    [{ ABIGAAIL_SMTP_HOST: "smtp.example.com", ABIGAAIL_ALERT_EMAIL_TO: "a@example.com" }, "ABIGAAIL_ALERT_EMAIL_FROM must be one email address"],
    [{ ABIGAAIL_SMTP_HOST: "smtp.example.com", ABIGAAIL_ALERT_EMAIL_FROM: "a@example.com", ABIGAAIL_ALERT_EMAIL_TO: "x@example.com\r\nBcc: evil@example.com" }, "ABIGAAIL_ALERT_EMAIL_TO must be 1 to 5"],
    [{ ABIGAAIL_SMTP_HOST: "smtp.example.com", ABIGAAIL_ALERT_EMAIL_FROM: "a@example.com", ABIGAAIL_ALERT_EMAIL_TO: "1@e.com,2@e.com,3@e.com,4@e.com,5@e.com,6@e.com" }, "ABIGAAIL_ALERT_EMAIL_TO must be 1 to 5"],
    [{ ABIGAAIL_SMTP_HOST: "smtp.example.com", ABIGAAIL_SMTP_USER: "u", ABIGAAIL_ALERT_EMAIL_FROM: "a@example.com", ABIGAAIL_ALERT_EMAIL_TO: "b@example.com" }, "ABIGAAIL_SMTP_USER and ABIGAAIL_SMTP_PASSWORD must be set together"],
    [{ ABIGAAIL_SMTP_HOST: "smtp://smtp.example.com", ABIGAAIL_ALERT_EMAIL_FROM: "a@example.com", ABIGAAIL_ALERT_EMAIL_TO: "b@example.com" }, "ABIGAAIL_SMTP_HOST must be a host name"],
    [{ ABIGAAIL_SMTP_HOST: "smtp.example.com", ABIGAAIL_SMTP_PORT: "99999", ABIGAAIL_ALERT_EMAIL_FROM: "a@example.com", ABIGAAIL_ALERT_EMAIL_TO: "b@example.com" }, "ABIGAAIL_SMTP_PORT must be a port number"],
    [{ ABIGAAIL_ALERT_EMAIL_TO: "b@example.com" }, "ABIGAAIL_ALERT_EMAIL_TO is set but ABIGAAIL_SMTP_HOST is not"],
    [{ ABIGAAIL_DASHBOARD_URL: "https://dash.example/?token=SECRET" }, "ABIGAAIL_DASHBOARD_URL must be a plain http(s) URL"],
    [{ ABIGAAIL_HEARTBEAT_URL: "https://192.168.1.5/push/SECRET" }, "ABIGAAIL_HEARTBEAT_URL is not allowed: private address (set ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE=1"],
    [{ ABIGAAIL_HEARTBEAT_URL: "https://169.254.169.254/push/SECRET", ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE: "1" }, "ABIGAAIL_HEARTBEAT_URL is not allowed: link-local address"],
    [{ ABIGAAIL_HEARTBEAT_URL: "https://hc-ping.com/SECRET", ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE: "true" }, "ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE must be 1 or unset"],
    [{ ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE: "1" }, "ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE is set but ABIGAAIL_HEARTBEAT_URL is not"],
    [{ ABIGAAIL_HEARTBEAT_URL: "http://hc-ping.com/SECRET" }, "ABIGAAIL_HEARTBEAT_URL is not allowed: plain http"],
  ])("refuses %o", (env, message) => {
    expect(fails(env)).toContain(message);
  });

  it("each URL has its own opt-in: the webhook's does not open the heartbeat, nor the other way round", () => {
    expect(loadAlertConfig({ ...base, ABIGAAIL_ALERT_WEBHOOK_URL: "https://192.168.1.5/hook", ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE: "1" }).webhook?.allowPrivate).toBe(true);
    expect(fails({ ...base, ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE: "1", ABIGAAIL_HEARTBEAT_URL: "https://192.168.1.5/push" })).toContain("ABIGAAIL_HEARTBEAT_URL is not allowed: private address");
    const hb = loadAlertConfig({ ABIGAAIL_HEARTBEAT_URL: "https://100.101.102.103:3001/api/push/x", ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE: "1" });
    expect(hb).toMatchObject({ heartbeatAllowPrivate: true });
    expect(loadAlertConfig({ ABIGAAIL_HEARTBEAT_URL: "https://hc-ping.com/x" })).toMatchObject({ heartbeatAllowPrivate: false });
    expect(fails({ ...base, ABIGAAIL_ALERT_WEBHOOK_URL: "https://192.168.1.5/hook", ABIGAAIL_HEARTBEAT_URL: "https://hc-ping.com/x", ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE: "1" }))
      .toContain("ABIGAAIL_ALERT_WEBHOOK_URL is not allowed: private address");
  });

  it("an invalid setting stops the server (loadConfig throws)", () => {
    expect(() => loadConfig({ ABIGAAIL_ALERT_WEBHOOK_URL: "http://example.com/x" })).toThrow(/ABIGAAIL_ALERT_WEBHOOK_URL/);
  });
});
