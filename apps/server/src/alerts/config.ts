// Alert settings, from the environment only (DECISIONS #96). Nothing set:
// alerts are off. A setting that is set but invalid throws, so the server
// does not start; the message names the variable, never its value.

import { ALERTS } from "../agents/thresholds.js";
import { checkUrl, UrlRefused } from "./url.js";

export const WEBHOOK_FORMATS = ["json", "slack", "discord", "ntfy"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export interface WebhookConfig {
  url: URL;
  /** HMAC-SHA256 key for X-Abigaail-Signature. */
  secret: string;
  format: WebhookFormat;
  /** ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE=1: a receiver on the owner's own network (never link-local). */
  allowPrivate: boolean;
}

export interface EmailConfig {
  host: string;
  port: number;
  /** Port 465: TLS from the first byte. Any other port: STARTTLS, required. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  to: string[];
}

export interface AlertConfig {
  webhook?: WebhookConfig;
  email?: EmailConfig;
  /** Base of the links in alerts; without it alerts carry no link. */
  dashboardUrl?: URL;
  /** Dead-man's switch pinged while /healthz is ok. */
  heartbeatUrl?: URL;
}

// No spaces, quotes, angle brackets, commas or semicolons: one plain address, nothing a header could split on.
const EMAIL_RE = /^[^\s@<>,;"'()\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\d{1,3}(?:\.\d{1,3}){3}$/;

function url(env: NodeJS.ProcessEnv, key: string, allowPrivate = false): URL | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  try {
    return checkUrl(raw, { allowPrivate });
  } catch (err) {
    throw new Error(`${key} is not allowed: ${err instanceof UrlRefused ? err.reason : "invalid"}`);
  }
}

function webhook(env: NodeJS.ProcessEnv): WebhookConfig | undefined {
  const allowRaw = env.ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE?.trim();
  if (allowRaw && allowRaw !== "1") throw new Error("ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE must be 1 or unset");
  const allowPrivate = allowRaw === "1";
  const target = url(env, "ABIGAAIL_ALERT_WEBHOOK_URL", allowPrivate);
  const secret = env.ABIGAAIL_ALERT_WEBHOOK_SECRET ?? "";
  const formatRaw = env.ABIGAAIL_ALERT_WEBHOOK_FORMAT?.trim().toLowerCase();
  if (!target) {
    for (const key of ["ABIGAAIL_ALERT_WEBHOOK_SECRET", "ABIGAAIL_ALERT_WEBHOOK_FORMAT", "ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE"]) {
      if (env[key]?.trim()) throw new Error(`${key} is set but ABIGAAIL_ALERT_WEBHOOK_URL is not`);
    }
    return undefined;
  }
  if (secret.length < ALERTS.minSecretLength) {
    throw new Error(`ABIGAAIL_ALERT_WEBHOOK_SECRET must be at least ${ALERTS.minSecretLength} characters (openssl rand -base64 32)`);
  }
  const format = (formatRaw || "json") as WebhookFormat;
  if (!WEBHOOK_FORMATS.includes(format)) throw new Error(`ABIGAAIL_ALERT_WEBHOOK_FORMAT must be one of ${WEBHOOK_FORMATS.join(", ")}`);
  return { url: target, secret, format, allowPrivate };
}

function email(env: NodeJS.ProcessEnv): EmailConfig | undefined {
  const host = env.ABIGAAIL_SMTP_HOST?.trim();
  const keys = ["ABIGAAIL_SMTP_PORT", "ABIGAAIL_SMTP_USER", "ABIGAAIL_SMTP_PASSWORD", "ABIGAAIL_ALERT_EMAIL_FROM", "ABIGAAIL_ALERT_EMAIL_TO"];
  if (!host) {
    for (const key of keys) if (env[key]?.trim()) throw new Error(`${key} is set but ABIGAAIL_SMTP_HOST is not`);
    return undefined;
  }
  if (!HOST_RE.test(host) || host.length > 253) throw new Error("ABIGAAIL_SMTP_HOST must be a host name or IPv4 address");
  const portRaw = env.ABIGAAIL_SMTP_PORT?.trim() || "587";
  const port = Number(portRaw);
  if (!/^\d{1,5}$/.test(portRaw) || port < 1 || port > 65535) throw new Error("ABIGAAIL_SMTP_PORT must be a port number");
  const user = env.ABIGAAIL_SMTP_USER?.trim() || undefined;
  const password = env.ABIGAAIL_SMTP_PASSWORD || undefined;
  if (!!user !== !!password) throw new Error("ABIGAAIL_SMTP_USER and ABIGAAIL_SMTP_PASSWORD must be set together");
  const from = env.ABIGAAIL_ALERT_EMAIL_FROM?.trim() ?? "";
  if (!EMAIL_RE.test(from)) throw new Error("ABIGAAIL_ALERT_EMAIL_FROM must be one email address");
  const to = (env.ABIGAAIL_ALERT_EMAIL_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length || to.length > ALERTS.maxRecipients || !to.every((a) => EMAIL_RE.test(a))) {
    throw new Error(`ABIGAAIL_ALERT_EMAIL_TO must be 1 to ${ALERTS.maxRecipients} comma-separated email addresses`);
  }
  return { host, port, secure: port === 465, ...(user ? { user, password: password! } : {}), from, to };
}

/** The dashboard link base is only shown, never fetched: http or https, no credentials, no query. */
function dashboardUrl(env: NodeJS.ProcessEnv): URL | undefined {
  const raw = env.ABIGAAIL_DASHBOARD_URL?.trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("ABIGAAIL_DASHBOARD_URL is not a URL");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) {
    throw new Error("ABIGAAIL_DASHBOARD_URL must be a plain http(s) URL without credentials, query or fragment");
  }
  return u;
}

export function loadAlertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const w = webhook(env);
  const e = email(env);
  const d = dashboardUrl(env);
  const h = url(env, "ABIGAAIL_HEARTBEAT_URL");
  return { ...(w ? { webhook: w } : {}), ...(e ? { email: e } : {}), ...(d ? { dashboardUrl: d } : {}), ...(h ? { heartbeatUrl: h } : {}) };
}
