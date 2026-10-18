// Values derived at ingest from data that is then discarded.

import { createHmac } from "node:crypto";

/** The furthest back a client may place an event relative to its send time. */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Authoritative event time on the server clock. Only the difference
 * `sent_at - client_ts` is used: both come from the same client clock, so a
 * client clock that is hours off still yields the right time. Clamped to
 * [0, 24h] so a bogus client cannot place events in the future or far past.
 */
export function eventTime(receivedAt: number, sentAt: number | undefined, clientTs: number): number {
  if (sentAt === undefined) return receivedAt;
  const waited = Math.min(Math.max(sentAt - clientTs, 0), MAX_EVENT_AGE_MS);
  return receivedAt - waited;
}

/** UTC calendar day, "YYYY-MM-DD". The salt day is always taken from receive time. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Pseudonymous visitor id: HMAC-SHA256 keyed by the day's salt over app id, IP
 * and user agent, truncated to 16 bytes. The app id stops hashes from being
 * linked across apps; the daily salt (deleted at day end) stops linking across days.
 */
export function visitorHash(salt: Buffer, appId: string, ip: string, ua: string | undefined): string {
  return createHmac("sha256", salt)
    .update(`${appId}\n${ip.toLowerCase()}\n${ua ?? ""}`)
    .digest()
    .subarray(0, 16)
    .toString("hex");
}

export type BotClass = "human" | "crawler" | "ai_crawler" | "automation" | "unknown";
export type BrowserFamily = "chrome" | "edge" | "firefox" | "safari" | "opera" | "samsung" | "other";

// Checked in order; first match wins. Small fixed outputs keep cardinality low.
const AI_CRAWLERS = /gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|bytespider|google-extended|meta-externalagent|amazonbot|cohere-ai/i;
const CRAWLERS = /googlebot|bingbot|duckduckbot|yandex|baiduspider|applebot|slurp|facebookexternalhit|twitterbot|linkedinbot|ahrefsbot|semrushbot|mj12bot|petalbot|crawler|spider|\bbot\b|bot\//i;
const AUTOMATION = /curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy|headlesschrome|phantomjs|puppeteer|playwright|selenium|postman/i;

/** Classify a user agent into a bot class and browser family. The UA itself is discarded. */
export function classifyUserAgent(ua: string | undefined): { bot_class: BotClass; browser: BrowserFamily | null } {
  if (!ua) return { bot_class: "unknown", browser: null };
  if (AI_CRAWLERS.test(ua)) return { bot_class: "ai_crawler", browser: null };
  if (CRAWLERS.test(ua)) return { bot_class: "crawler", browser: null };
  if (AUTOMATION.test(ua)) return { bot_class: "automation", browser: null };
  return { bot_class: "human", browser: browserFamily(ua) };
}

function browserFamily(ua: string): BrowserFamily {
  if (/\bEdgA?\/|\bEdgiOS\//.test(ua)) return "edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "opera";
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "firefox";
  if (/\bChrome\/|\bCriOS\/|\bChromium\//.test(ua)) return "chrome";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return "safari";
  return "other";
}
