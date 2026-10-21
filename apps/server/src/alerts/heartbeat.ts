// Dead-man's switch (DECISIONS #98): while /healthz would answer ok, the
// server GETs ABIGAAIL_HEARTBEAT_URL every ALERTS.heartbeatEveryMs. A service
// such as healthchecks.io or Uptime Kuma (push monitor) alerts when the pings
// stop: Abigaail down, its host down, or the Watchdog stalled. Same URL rules
// as the webhook (no private addresses); the URL is never logged.

import { ALERTS } from "../agents/thresholds.js";
import { send, type RequestOptions, type SendResult } from "./http.js";

export interface HeartbeatOptions {
  url: URL;
  /** Whether Abigaail is healthy right now (what /healthz answers). */
  healthy: () => boolean;
  everyMs?: number;
  timeoutMs?: number;
  /** Fixed messages only. */
  log?: (msg: string) => void;
  /** Tests only. */
  resolve?: RequestOptions["resolve"];
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private failing = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: HeartbeatOptions) {
    this.log = opts.log ?? ((msg) => console.error(`[abigaail] ${msg}`));
  }

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.opts.everyMs ?? ALERTS.heartbeatEveryMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** One ping, only while healthy; a failure is logged once per streak. Never throws. */
  async beat(): Promise<SendResult | undefined> {
    if (!this.opts.healthy()) return undefined;
    const r = await send(this.opts.url, {
      method: "GET",
      timeoutMs: this.opts.timeoutMs ?? ALERTS.heartbeatTimeoutMs,
      maxBytes: ALERTS.responseMaxBytes,
      ...(this.opts.resolve ? { resolve: this.opts.resolve } : {}),
    });
    if (!r.ok && !this.failing) this.log(`heartbeat: ping failed (${r.error ?? "Error"}${r.code !== undefined ? ` ${r.code}` : ""})`);
    if (r.ok && this.failing) this.log("heartbeat: ping works again");
    this.failing = !r.ok;
    return r;
  }
}
