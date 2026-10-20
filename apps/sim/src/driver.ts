// Sends the traffic model to a demo app over HTTP, one second at a time.
// Only to a URL that passed assertLocalTarget, always to the literal loopback
// address; bounded concurrency; every request times out; stop() ends it all.

import http from "node:http";
import { connectAddress } from "./guard.js";
import { rng, type Rng } from "./random.js";
import { generate, NORMAL_MODE, SEC, type AppKind, type Mode, type SimRequest } from "./traffic.js";

const MAX_IN_FLIGHT = 256;
const TIMEOUT_MS = 5000;

export class Driver {
  mode: Mode = { ...NORMAL_MODE };
  readonly stats = { sent: 0, answered: 0, failed: 0, skipped: 0 };
  private readonly r: Rng;
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly abort = new AbortController();
  private readonly timers = new Set<NodeJS.Timeout>();
  private tick: NodeJS.Timeout | undefined;
  private inFlight = 0;
  /** Answer times by kind, for comparing with what the store counted. */
  private readonly humans: number[] = [];
  private readonly others: number[] = [];

  constructor(
    private readonly url: URL,
    private readonly app: AppKind,
    seed: number,
  ) {
    this.r = rng(seed);
  }

  start(): void {
    let next = Date.now();
    const step = () => {
      const now = Date.now();
      for (const req of generate(this.r, this.app, next, next + SEC, this.mode)) {
        const t = setTimeout(() => (this.timers.delete(t), this.send(req)), Math.max(0, req.at - now));
        this.timers.add(t);
      }
      next += SEC;
      this.tick = setTimeout(step, Math.max(0, next - Date.now()));
    };
    step();
  }

  private send(req: SimRequest): void {
    if (this.abort.signal.aborted) return;
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.stats.skipped++;
      return;
    }
    this.inFlight++;
    this.stats.sent++;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      this.inFlight--;
      if (!ok) {
        this.stats.failed++;
        return;
      }
      this.stats.answered++;
      (req.kind === "human" ? this.humans : this.others).push(Date.now());
    };
    const headers: Record<string, string> = { host: this.url.host, "user-agent": req.ua };
    if (req.referer) headers.referer = req.referer;
    const r = http.request(
      { host: connectAddress(this.url), port: Number(this.url.port), path: req.path, method: "GET", headers, agent: this.agent, timeout: TIMEOUT_MS, signal: this.abort.signal },
      (res) => {
        res.resume();
        res.once("end", () => done(true));
        // Closed without a complete body (aborted, or the demo was killed).
        res.once("close", () => done(res.complete));
      },
    );
    r.once("timeout", () => r.destroy());
    r.once("error", () => done(false));
    r.end();
  }

  /** Requests answered with an answer time in [from, to). */
  answered(from: number, to: number): { humans: number; others: number } {
    const count = (xs: number[]) => xs.reduce((n, t) => n + (t >= from && t < to ? 1 : 0), 0);
    return { humans: count(this.humans), others: count(this.others) };
  }

  stop(): void {
    clearTimeout(this.tick);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.abort.abort();
    this.agent.destroy();
  }
}
