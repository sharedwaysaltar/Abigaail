// The two channels (DECISIONS #96). Each send is one attempt with its own
// timeout and never throws; retries belong to the alerter. Neither logs:
// URLs, secrets, recipients and the receiver's answers stay out of every log.

import nodemailer from "nodemailer";
import { ALERTS } from "../agents/thresholds.js";
import type { AlertConfig, EmailConfig, WebhookConfig } from "./config.js";
import { subject, text, webhookRequest, type AlertMessage } from "./format.js";
import { failureCode, send, type RequestOptions, type SendResult } from "./http.js";

export type ChannelName = "webhook" | "email";

export interface Channel {
  name: ChannelName;
  /** What the dashboard shows: kind, format and host, or a recipient count. Never a path, secret or address. */
  label: string;
  send(m: AlertMessage): Promise<SendResult>;
}

export interface WebhookOptions {
  timeoutMs?: number;
  now?: () => number;
  /** Tests only. */
  resolve?: RequestOptions["resolve"];
  ca?: string;
}

export function webhookChannel(cfg: WebhookConfig, o: WebhookOptions = {}): Channel {
  const now = o.now ?? Date.now;
  return {
    name: "webhook",
    label: `webhook (${cfg.format}, ${cfg.url.hostname}${cfg.allowPrivate ? ", private addresses allowed" : ""})`,
    send(m) {
      // Signed at each attempt, so a retry carries a fresh timestamp.
      const { body, headers } = webhookRequest(m, cfg.format, cfg.secret, now());
      return send(cfg.url, {
        method: "POST",
        headers,
        body,
        timeoutMs: o.timeoutMs ?? ALERTS.webhookTimeoutMs,
        maxBytes: ALERTS.responseMaxBytes,
        policy: { allowPrivate: cfg.allowPrivate },
        ...(o.resolve ? { resolve: o.resolve } : {}),
        ...(o.ca ? { ca: o.ca } : {}),
      });
    },
  };
}

export interface EmailOptions {
  timeoutMs?: number;
  /** Tests only: trust this CA (certificates are still verified). */
  ca?: string;
}

/**
 * SMTP through nodemailer: TLS from the first byte on port 465, otherwise
 * STARTTLS is required (requireTLS: a server that does not offer it gets
 * nothing), certificates verified, TLS 1.2 at least. Plain text only.
 */
export function emailChannel(cfg: EmailConfig, o: EmailOptions = {}): Channel {
  const timeoutMs = o.timeoutMs ?? ALERTS.smtpTimeoutMs;
  return {
    name: "email",
    label: `email via ${cfg.host}:${cfg.port} to ${cfg.to.length} recipient${cfg.to.length === 1 ? "" : "s"}`,
    async send(m) {
      const step = Math.max(1, Math.floor(timeoutMs / 3));
      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        requireTLS: !cfg.secure,
        ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.password! } } : {}),
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: cfg.host, ...(o.ca ? { ca: o.ca } : {}) },
        connectionTimeout: step,
        greetingTimeout: step,
        socketTimeout: step,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<SendResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: "Timeout" }), timeoutMs);
        timer.unref();
      });
      const attempt = transport
        .sendMail({
          from: cfg.from,
          to: cfg.to,
          subject: subject(m),
          text: text(m),
          headers: { "X-Abigaail-Delivery": m.delivery_id },
          disableFileAccess: true,
          disableUrlAccess: true,
        })
        .then((): SendResult => ({ ok: true }))
        .catch((err: unknown): SendResult => {
          const code = (err as { responseCode?: unknown }).responseCode;
          return { ok: false, error: failureCode(err), ...(typeof code === "number" ? { code } : {}) };
        });
      try {
        return await Promise.race([attempt, timeout]);
      } finally {
        clearTimeout(timer);
        transport.close();
      }
    },
  };
}

/** The configured channels, webhook first. */
export function makeChannels(cfg: AlertConfig, o: { webhook?: WebhookOptions; email?: EmailOptions } = {}): Channel[] {
  return [
    ...(cfg.webhook ? [webhookChannel(cfg.webhook, o.webhook)] : []),
    ...(cfg.email ? [emailChannel(cfg.email, o.email)] : []),
  ];
}
