// What an alert says (DECISIONS #97). An item is built from a fixed list of
// finding fields (ITEM_FIELDS): agents write summaries, causes and actions
// from route patterns, host names and numbers only, and `evidence` is never
// sent. Every channel renders the same message.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Finding, Severity } from "@abigaail/store";
import { ALERTS } from "../agents/thresholds.js";
import type { WebhookFormat } from "./config.js";

export interface AlertItem {
  /** App name, or "Abigaail" for its own findings. */
  app: string;
  change: "firing" | "recovered";
  severity: Severity;
  signal: string;
  /** Firing: the finding's summary now. Recovered: its summary when the alert went red (what was wrong). */
  summary: string;
  cause: string | null;
  action: string;
  first_seen: number;
  resolved_at: number | null;
  /** Recovered only because it was not seen again after Abigaail restarted. */
  not_observed: boolean;
  /** State changes since the previous message about it, not counting this one. */
  flaps: number;
  link: string | null;
}

/** The only fields an item carries. A test keeps the builder to this list. */
export const ITEM_FIELDS = [
  "app", "change", "severity", "signal", "summary", "cause", "action", "first_seen", "resolved_at", "not_observed", "flaps", "link",
] as const satisfies readonly (keyof AlertItem)[];

export interface AlertMessage {
  version: 1;
  /** Random per message and channel; the receiver can drop a repeat. */
  delivery_id: string;
  kind: "alert" | "storm" | "test";
  created_at: number;
  items: AlertItem[];
  /** Further items not listed (see the dashboard). */
  more: number;
}

/** Link to the finding on the dashboard, or null without ABIGAAIL_DASHBOARD_URL. */
export function findingLink(base: URL | undefined, app: string | null, f: Pick<Finding, "id" | "state">): string | null {
  if (!base) return null;
  const p = new URLSearchParams();
  if (app) p.set("app", app);
  if (f.state === "resolved") p.set("state", "resolved");
  const q = p.toString();
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/findings${q ? `?${q}` : ""}#finding-${f.id}`;
}

export function itemFrom(
  f: Finding,
  app: string,
  change: AlertItem["change"],
  o: { flaps: number; notObserved?: boolean; link: string | null; summary?: string },
): AlertItem {
  return {
    app,
    change,
    severity: f.severity,
    signal: f.signal,
    summary: o.summary ?? f.summary,
    cause: f.cause,
    action: f.action,
    first_seen: f.first_seen,
    resolved_at: f.resolved_at,
    not_observed: !!o.notObserved,
    flaps: o.flaps,
    link: o.link,
  };
}

const utc = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function lasted(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** One line per item, then its cause, action and link. */
function itemLines(i: AlertItem): string[] {
  const head = i.change === "firing"
    ? `🔴 ${i.app}: ${i.summary}`
    : i.not_observed
      ? `✅ ${i.app}: no longer seen after Abigaail restarted (was: ${i.summary})`
      : `✅ ${i.app}: resolved${i.resolved_at !== null ? ` after ${lasted(i.resolved_at - i.first_seen)}` : ""} (was: ${i.summary})`;
  const out = [head];
  if (i.change === "firing") {
    if (i.cause) out.push(`Likely cause: ${i.cause}`);
    out.push(`What to do: ${i.action}`);
  }
  const meta = [`since ${utc(i.first_seen)}`];
  if (i.flaps > 0) meta.push(`changed ${i.flaps} more time${i.flaps === 1 ? "" : "s"} since the last message`);
  if (i.link) meta.push(i.link);
  out.push(meta.join(" · "));
  return out;
}

function headline(m: AlertMessage): string {
  if (m.kind === "test") return "Abigaail test alert";
  const firing = m.items.filter((i) => i.change === "firing").length;
  const recovered = m.items.length - firing;
  const parts = [firing ? `${firing} red` : "", recovered ? `${recovered} resolved` : ""].filter(Boolean);
  const apps = [...new Set(m.items.map((i) => i.app))];
  const storm = m.kind === "storm" ? " (alert storm: further messages this hour are only on the dashboard)" : "";
  return `Abigaail: ${parts.join(", ")}${m.more ? ` and ${m.more} more` : ""} · ${apps.join(", ")}${storm}`;
}

/** Email subject and ntfy title: one line, no control characters. */
export function subject(m: AlertMessage): string {
  const one = m.items.length === 1 && !m.more ? m.items[0]! : undefined;
  const s = one && m.kind === "alert"
    ? one.change === "firing" ? `Abigaail: RED · ${one.app}: ${one.summary}` : `Abigaail: resolved · ${one.app} (was: ${one.summary})`
    : headline(m);
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

export function text(m: AlertMessage): string {
  const blocks = m.items.map((i) => itemLines(i).join("\n"));
  if (m.more) blocks.push(`… and ${m.more} more on the dashboard.`);
  return [headline(m), ...blocks].join("\n\n");
}

/** Slack mrkdwn: &, < and > must be escaped, which also keeps <!channel> out. */
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTTP header values must be visible ASCII. */
const asciiHeader = (s: string) => s.replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);

export interface WebhookRequest {
  body: string;
  headers: Record<string, string>;
}

/**
 * The body for each format, and the signature header on every one:
 * X-Abigaail-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.
 */
export function webhookRequest(m: AlertMessage, format: WebhookFormat, secret: string, now: number): WebhookRequest {
  let body: string;
  const headers: Record<string, string> = { "x-abigaail-delivery": m.delivery_id };
  switch (format) {
    case "slack":
      body = JSON.stringify({ text: slackEscape(text(m)) });
      headers["content-type"] = "application/json";
      break;
    case "discord": {
      const t = text(m);
      body = JSON.stringify({
        content: t.length > ALERTS.discordMaxChars ? `${t.slice(0, ALERTS.discordMaxChars - 1)}…` : t,
        allowed_mentions: { parse: [] },
      });
      headers["content-type"] = "application/json";
      break;
    }
    case "ntfy": {
      const firing = m.items.some((i) => i.change === "firing");
      body = text(m);
      headers["content-type"] = "text/plain; charset=utf-8";
      headers.title = asciiHeader(subject(m));
      headers.priority = m.kind === "test" ? "default" : firing ? "urgent" : "default";
      headers.tags = m.kind === "test" ? "test_tube" : firing ? "rotating_light" : "white_check_mark";
      const link = m.items.length === 1 ? m.items[0]!.link : null;
      if (link) headers.click = link;
      break;
    }
    default:
      body = JSON.stringify({ ...m, text: text(m) });
      headers["content-type"] = "application/json";
  }
  const t = Math.floor(now / 1000);
  headers["x-abigaail-signature"] = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  return { body, headers };
}

/** How a receiver checks a message (the README shows the same steps). */
export function verifySignature(header: string, body: string, secret: string, now: number, toleranceMs = 5 * 60_000): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t * 1000) > toleranceMs) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(m[2]!, "hex");
  return given.length === expected.length && timingSafeEqual(expected, given);
}

/** The sample `npm run alerts:test` sends: clearly a test, about no real app. */
export function testMessage(base: URL | undefined, now: number, delivery_id: string): AlertMessage {
  return {
    version: 1,
    delivery_id,
    kind: "test",
    created_at: now,
    items: [{
      app: "example-app",
      change: "firing",
      severity: "critical",
      signal: "test",
      summary: "This is a test alert from Abigaail. Nothing is wrong.",
      cause: null,
      action: "Nothing to do: if you can read this, alerts reach you.",
      first_seen: now,
      resolved_at: null,
      not_observed: false,
      flaps: 0,
      link: base ? `${base.origin}${base.pathname.replace(/\/+$/, "")}/alerts` : null,
    }],
    more: 0,
  };
}
