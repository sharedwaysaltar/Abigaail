// The traffic model, shared by the seeded history and the live run so that
// "normal" in the store is what the live run sends: human requests on an
// hour-of-week curve, plus background bots and probes.

import { BOT_UAS, humanUa, INJECTION_PATHS, REFERRER_SHARE, REFERRERS, SCANNER_PATHS, VISITORS, type BotKind } from "./identity.js";
import { pick, poisson, type Rng } from "./random.js";

export type AppKind = "node" | "next";
export type Kind = "human" | BotKind | "probe";

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Human requests per minute: the quietest hours never drop below this, so every check has evidence. */
export const FLOOR_PER_MIN = 30;
export const WEEKDAY_PEAK_PER_MIN = 80;
export const WEEKEND_PEAK_PER_MIN = 55;

/** Human requests per minute at time t: a daytime hump (06-22 UTC, peak 14:00), lower at weekends. */
export function humanRate(t: number): number {
  const d = new Date(t);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  const day = Math.max(0, Math.sin((Math.PI * (hour - 6)) / 16));
  return FLOOR_PER_MIN + ((weekend ? WEEKEND_PEAK_PER_MIN : WEEKDAY_PEAK_PER_MIN) - FLOOR_PER_MIN) * day;
}

export const PEAK_PER_MIN = WEEKDAY_PEAK_PER_MIN;

interface RouteShare {
  share: number;
  path: (r: Rng) => string;
}

const userPath = (r: Rng) => `/user/${1 + Math.floor(r() * 5000)}`;

/** Human route mix per demo app. */
export const HUMAN_ROUTES: Record<AppKind, readonly RouteShare[]> = {
  node: [
    { share: 0.15, path: () => "/" },
    { share: 0.2, path: () => "/docs" },
    { share: 0.25, path: userPath },
    { share: 0.25, path: () => "/search" },
    { share: 0.15, path: () => "/checkout" },
  ],
  next: [
    { share: 0.3, path: () => "/" },
    { share: 0.25, path: () => "/about" },
    { share: 0.3, path: userPath },
    { share: 0.15, path: () => "/api/slow" },
  ],
};

/** Pages crawlers and automation fetch (never ones with side effects). */
const BOT_PATHS: Record<AppKind, readonly ((r: Rng) => string)[]> = {
  node: [() => "/", () => "/docs", userPath],
  next: [() => "/", () => "/about", userPath],
};

/** Background bots and probes, as a multiple of the human rate. */
export const BOTS_BACKGROUND = 0.3;
/** The bots scenario's burst. Sized against ingest and SDK limits in sizing(). */
export const BOTS_BURST = 5;
const BOT_MIX: readonly [Kind, number][] = [["crawler", 0.35], ["ai_crawler", 0.2], ["automation", 0.2], ["probe", 0.25]];

export interface Mode {
  /** Human traffic on (off for a traffic collapse). */
  humans: boolean;
  /** Bots and probes as a multiple of the human rate (they continue when humans stop). */
  bots: number;
  /** Extra human requests per minute to fixed paths (e.g. a broken route). */
  extra: readonly { path: string; perMin: number }[];
}

export const NORMAL_MODE: Mode = { humans: true, bots: BOTS_BACKGROUND, extra: [] };

export interface SimRequest {
  at: number;
  kind: Kind;
  path: string;
  ua: string;
  referer?: string;
}

function weighted<T>(r: Rng, items: readonly [T, number][]): T {
  let x = r() * items.reduce((s, [, w]) => s + w, 0);
  for (const [item, w] of items) if ((x -= w) < 0) return item;
  return items[items.length - 1]![0];
}

function human(r: Rng, at: number, path: string): SimRequest {
  const req: SimRequest = { at, kind: "human", path, ua: humanUa(Math.floor(r() * VISITORS)) };
  if (r() < REFERRER_SHARE) req.referer = pick(r, REFERRERS);
  return req;
}

/** Requests arriving in [from, to), Poisson per second, in time order. */
export function generate(r: Rng, app: AppKind, from: number, to: number, mode: Mode): SimRequest[] {
  const out: SimRequest[] = [];
  const routes = HUMAN_ROUTES[app].map((x) => [x, x.share] as [RouteShare, number]);
  for (let s = from; s < to; s += SEC) {
    const span = Math.min(SEC, to - s);
    const perSec = humanRate(s) / 60;
    const at = () => s + Math.floor(r() * span);
    if (mode.humans) {
      for (let i = poisson(r, (perSec * span) / SEC); i > 0; i--) out.push(human(r, at(), weighted(r, routes).path(r)));
      for (const e of mode.extra) for (let i = poisson(r, (e.perMin / 60) * (span / SEC)); i > 0; i--) out.push(human(r, at(), e.path));
    }
    for (let i = poisson(r, (mode.bots * perSec * span) / SEC); i > 0; i--) {
      const kind = weighted(r, BOT_MIX);
      if (kind === "probe") {
        const probes = [...SCANNER_PATHS, ...INJECTION_PATHS[app]];
        out.push({ at: at(), kind, path: pick(r, probes), ua: humanUa(Math.floor(r() * VISITORS)) });
      } else {
        out.push({ at: at(), kind, path: pick(r, BOT_PATHS[app])(r), ua: pick(r, BOT_UAS[kind as BotKind]) });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The defaults the bots burst is sized against: @abigaail/core's client
 * (maxQueue 1000, batchSize 100, sampling above 50% full) with the demos'
 * 1 s flush, and ingest's per-app limit (20 batches/s, burst 40, server.ts).
 */
export const LIMITS_ASSUMED = { sdkMaxQueue: 1000, sdkSampleThreshold: 0.5, sdkBatchSize: 100, flushMs: 1000, ingestBatchesPerSec: 20 };

/**
 * Worst case of the live run: peak human rate, every human request making an
 * outbound call and an error (an overestimate), plus the bots burst.
 */
export function sizing(limits = LIMITS_ASSUMED) {
  const humansPerSec = PEAK_PER_MIN / 60 + 15 / 60; // + the largest `extra`
  const botsPerSec = (BOTS_BURST * PEAK_PER_MIN) / 60;
  // Lifecycle and metric events are a handful per minute; count 1/s.
  const eventsPerSec = humansPerSec * 3 + botsPerSec * 2 + 1;
  const queuePeak = eventsPerSec * (limits.flushMs / SEC);
  const batchesPerSec = Math.max(SEC / limits.flushMs, eventsPerSec / limits.sdkBatchSize);
  return {
    eventsPerSec,
    queuePeak,
    /** Times below the queue fill at which the SDK starts sampling. */
    samplingMargin: (limits.sdkSampleThreshold * limits.sdkMaxQueue) / queuePeak,
    batchesPerSec,
    /** Times below ingest's per-app rate limit. */
    rateMargin: limits.ingestBatchesPerSec / batchesPerSec,
  };
}
