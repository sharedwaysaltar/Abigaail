// Fixtures for the alert tests: a webhook receiver and an SMTP server on
// 127.0.0.1 that can answer, refuse or hang, and a recording channel.
// test-localhost.{crt,key} are a self-signed pair for localhost made only for
// these tests (openssl, 100 years); the client is given the cert as its CA, so
// certificate verification stays on.

import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import type { Channel, ChannelName, AlertMessage, SendResult } from "@abigaail/server";
import type { FindingInput, Severity, Store } from "@abigaail/store";

export const TEST_CERT = readFileSync(new URL("./fixtures/test-localhost.crt", import.meta.url), "utf8");
export const TEST_KEY = readFileSync(new URL("./fixtures/test-localhost.key", import.meta.url), "utf8");

export interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A webhook receiver. mode: "ok" (204), a status code, "hang" (never answers) or "redirect". */
export async function receiver(mode: { current: "ok" | "hang" | "redirect" | number } = { current: "ok" }) {
  const got: Received[] = [];
  const sockets = new Set<net.Socket>();
  const server: HttpServer = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      got.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const m = mode.current;
      if (m === "hang") return;
      if (m === "redirect") {
        res.writeHead(302, { location: "/elsewhere" }).end();
        return;
      }
      res.writeHead(m === "ok" ? 204 : m).end();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    got,
    mode,
    port,
    url: `http://127.0.0.1:${port}/hook`,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface SmtpOptions {
  /** Advertise STARTTLS (default true). */
  starttls?: boolean;
  /** Answer AUTH with 535. */
  rejectAuth?: boolean;
  /** Stop answering at this step. */
  hangAt?: "greeting" | "data";
}

/** A minimal SMTP server: EHLO, STARTTLS (with the test cert), AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
export async function smtpServer(o: SmtpOptions = {}) {
  const messages: { from: string; to: string[]; data: string; tls: boolean; auth: string | null }[] = [];
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    raw.on("error", () => {});
    let sock: net.Socket = raw;
    let secure = false;
    let buf = "";
    let inData = false;
    let data = "";
    let from = "";
    let to: string[] = [];
    let auth: string | null = null;
    const say = (line: string) => sock.write(`${line}\r\n`);
    const onLine = (line: string) => {
      commands.push(line.split(" ")[0]!.toUpperCase());
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") {
        const caps = [...(o.starttls !== false && !secure ? ["STARTTLS"] : []), "AUTH PLAIN", "8BITMIME"];
        say(["250-localhost", ...caps.slice(0, -1).map((c) => `250-${c}`), `250 ${caps.at(-1)}`].join("\r\n"));
      } else if (line.toUpperCase() === "STARTTLS") {
        // A server without STARTTLS refuses the command, as real ones do.
        if (o.starttls === false) return say("502 5.5.1 command not implemented");
        say("220 ready to start TLS");
        sock.removeAllListeners("data");
        const t = new tls.TLSSocket(raw, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
        t.on("error", () => {});
        sock = t;
        secure = true;
        buf = "";
        t.on("data", onData);
      } else if (cmd === "AUTH") {
        if (o.rejectAuth) return say("535 5.7.8 authentication failed for user secret-user");
        auth = line.split(" ")[2] ?? null;
        say("235 ok");
      } else if (cmd === "MAIL") {
        from = line;
        say("250 ok");
      } else if (cmd === "RCPT") {
        to.push(line);
        say("250 ok");
      } else if (cmd === "DATA") {
        if (o.hangAt === "data") return;
        inData = true;
        data = "";
        say("354 go ahead");
      } else if (cmd === "QUIT") {
        say("221 bye");
        sock.end();
      } else {
        say("250 ok");
      }
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          messages.push({ from, to, data, tls: secure, auth });
          from = "";
          to = [];
          say("250 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        onLine(line);
      }
    };
    raw.on("data", onData);
    if (o.hangAt !== "greeting") say("220 localhost ESMTP test");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    messages,
    commands,
    port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A channel that records every message; `results` decides each attempt's outcome (default ok). */
export function recordingChannel(name: ChannelName, results: { next: () => SendResult } = { next: () => ({ ok: true }) }) {
  const sent: AlertMessage[] = [];
  const channel: Channel = {
    name,
    label: `${name} (test)`,
    async send(m) {
      sent.push(m);
      return results.next();
    },
  };
  return { channel, sent, results };
}

let fp = 0;
/** One run of `agent` that emits these findings (scope = the given app, or Abigaail itself). */
export function emit(store: Store, at: number, appId: string | null, findings: { signal: string; subject?: string; severity: Severity; summary?: string; evidence?: Record<string, unknown> }[], agent = "health"): void {
  const inputs: FindingInput[] = findings.map((f) => ({
    app_id: appId,
    agent,
    fingerprint: `${agent}:${f.signal}:${f.subject ?? ""}`,
    signal: f.signal,
    severity: f.severity,
    summary: f.summary ?? `${f.signal} ${f.subject ?? ""} summary ${++fp}`,
    cause: "a cause",
    action: "an action",
    evidence: f.evidence ?? { n: 1 },
  }));
  store.recordRun({ agent, started_at: at - 100, finished_at: at, outcome: "ok", apps_ok: 1, apps_failed: 0 }, inputs, [appId]);
}
