// The alerter (DECISIONS #95-#98), in the server's main thread so alerts work
// with the dashboard down (#11). Once a minute it compares every app's
// confirmed red findings (isRed: critical, 2 runs in a row) with the
// persisted alert state and turns the changes into messages:
//
// - a fingerprint that turns red: one "firing" message, at most one per
//   ALERTS.cooldownMs (a re-fire inside it is held, then sent if still red);
// - one that is red no more because its finding resolved: one "recovered"
//   message. A finding closed as not observed during Abigaail's downtime
//   counts only once its agent's resolve window has passed without it coming
//   back. A finding that is merely downgraded sends nothing;
// - everything from one sweep goes out as one message per channel.
//
// State and messages are written in one transaction before anything is
// sent, so a restart never sends again. Sending is asynchronous, one message
// at a time per channel, with a timeout, retries with backoff and a bounded
// queue; ingest and the agents never wait on it.

import { randomUUID } from "node:crypto";
import { isRed, type AlertState, type DeliveryInput, type Finding, type PendingDelivery, type Store } from "@abigaail/store";
import { errorClass } from "../agents/evaluate.js";
import { ALERTS, FINDINGS, SCHEDULE } from "../agents/thresholds.js";
import type { Channel, ChannelName } from "./channels.js";
import { findingLink, itemFrom, testMessage, type AlertItem, type AlertMessage } from "./format.js";
import type { SendResult } from "./http.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type AlertLimits = typeof ALERTS;

export interface AlerterOptions {
  store: Store;
  channels: readonly Channel[];
  dashboardUrl?: URL;
  now?: () => number;
  /** Fixed messages only: channel names, counts, outcomes and error codes. */
  log?: (msg: string) => void;
  /** Overrides for tests. */
  limits?: Partial<AlertLimits>;
}

/** The fingerprint of the Watchdog's finding about a channel; never sent through that channel. */
export const deliveryFailedFingerprint = (channel: ChannelName) => `watchdog:alert_delivery_failed:${channel}`;

interface Change {
  item: AlertItem;
  app_id: string | null;
  finding_id: number;
  fingerprint: string;
}

interface Lane {
  channel: Channel;
  queue: PendingDelivery[];
  busy: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The send in flight, for tests and shutdown. */
  inflight: Promise<void> | undefined;
}

/** How long after a not-observed close (Abigaail restarted) its agent would have found it again. */
function notObservedGraceMs(agent: string): number {
  const every = (SCHEDULE as Record<string, { everyMs: number }>)[agent]?.everyMs ?? MINUTE_MS;
  return FINDINGS.resolveAfter * every;
}

export class Alerter {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly limits: AlertLimits;
  private readonly lanes = new Map<ChannelName, Lane>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private sweepFailing = false;

  constructor(private readonly opts: AlerterOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((msg) => console.error(`[abigaail] ${msg}`));
    this.limits = { ...ALERTS, ...opts.limits };
    for (const channel of opts.channels) this.lanes.set(channel.name, { channel, queue: [], busy: false, timer: undefined, inflight: undefined });
  }

  /** Resume what was queued before a restart, then sweep each minute until stop(). Never keeps the process alive. */
  start(): void {
    this.resume();
    const schedule = () => {
      if (this.stopped) return;
      const now = this.now();
      const every = this.limits.sweepEveryMs;
      let delay = every - (now % every) + this.limits.sweepOffsetMs;
      if (delay > every) delay -= every;
      this.timer = setTimeout(() => {
        this.sweep();
        schedule();
      }, delay);
      this.timer.unref();
    };
    schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const lane of this.lanes.values()) clearTimeout(lane.timer);
  }

  /** Wait for the sends in flight (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.lanes.values()].map((l) => l.inflight));
  }

  /**
   * Messages still pending at startup: resumed if young enough, else given up.
   * Pending messages of a channel no longer configured are given up too.
   */
  resume(): void {
    const now = this.now();
    for (const d of this.store.pendingDeliveries()) {
      const lane = this.lanes.get(d.channel as ChannelName);
      if (!lane || now - d.created_at > this.limits.resumeMaxAgeMs) {
        this.giveUp(d, lane ? "Expired" : "ChannelRemoved");
        continue;
      }
      this.enqueue(lane, d);
    }
    for (const lane of this.lanes.values()) this.pump(lane);
  }

  /** One sweep: judge, record, queue. Never throws; logged to agent_runs as "alerts". */
  sweep(): void {
    if (this.stopped) return;
    const startedAt = this.now();
    let error_class: string | undefined;
    let ids: number[] = [];
    let deliveries: DeliveryInput[] = [];
    try {
      const { states, changes } = this.judge(startedAt);
      deliveries = this.messages(changes, startedAt);
      if (states.length || deliveries.length) ids = this.store.applyAlerts(states, deliveries);
      if (this.sweepFailing) this.log("alerts: sweep works again");
      this.sweepFailing = false;
    } catch (err) {
      error_class = errorClass(err);
      if (!this.sweepFailing) this.log(`alerts: sweep failed (${error_class})`);
      this.sweepFailing = true;
    }
    try {
      this.store.recordRun(
        { agent: "alerts", started_at: startedAt, finished_at: this.now(), outcome: error_class ? "error" : "ok", error_class: error_class ?? null, apps_ok: 0, apps_failed: 0 },
        [],
        [],
      );
    } catch {
      // The run log is for the Watchdog; a failure here is already visible as a stalled "alerts".
    }
    deliveries.forEach((d, i) => {
      if (d.status !== "pending") return;
      const lane = this.lanes.get(d.channel as ChannelName);
      if (!lane) return;
      this.enqueue(lane, {
        id: ids[i]!, delivery_id: d.delivery_id, channel: d.channel, kind: d.kind, created_at: startedAt, payload: d.payload, attempts: 0, next_attempt_at: startedAt,
      });
      this.pump(lane);
    });
  }

  /** New alert states and the changes to announce, from the findings of every app and of Abigaail itself. */
  private judge(now: number): { states: AlertState[]; changes: Change[] } {
    const scopes: { id: string | null; name: string }[] = [...this.store.listApps().map((a) => ({ id: a.id, name: a.name })), { id: null, name: "Abigaail" }];
    const states: AlertState[] = [];
    const changes: Change[] = [];
    for (const scope of scopes) {
      const open = scope.id === null ? this.store.systemFindings() : this.store.openFindings(scope.id);
      const red = new Map(open.filter(isRed).map((f) => [f.fingerprint, f]));
      const openFps = new Set(open.map((f) => f.fingerprint));
      const known = new Map(this.store.alertStates(scope.id).map((s) => [s.fingerprint, s]));
      for (const fp of new Set([...red.keys(), ...known.keys()])) {
        const prev = known.get(fp);
        const redFinding = red.get(fp);
        let state: AlertState["state"] = prev?.state ?? "ok";
        let finding: Finding | undefined = redFinding;
        let notObserved = false;
        if (redFinding) {
          state = "firing";
        } else if (state === "firing" && !openFps.has(fp)) {
          // Red no more and not open: recovered, unless it was closed only because Abigaail was down.
          const latest = this.store.latestFinding(scope.id, fp);
          finding = latest;
          if (!latest || latest.state !== "resolved") state = "ok";
          else if (latest.resolved_reason !== "not_observed") state = "ok";
          else if (now - (latest.resolved_at ?? now) >= notObservedGraceMs(latest.agent)) {
            state = "ok";
            notObserved = true;
          }
        }
        const changed = state !== (prev?.state ?? "ok");
        const next: AlertState = {
          app_id: scope.id,
          fingerprint: fp,
          state,
          sent: prev?.sent ?? null,
          finding_id: finding?.id ?? prev?.finding_id ?? null,
          changed_at: changed ? now : (prev?.changed_at ?? now),
          fired_at: prev?.fired_at ?? null,
          fired_summary: prev?.fired_summary ?? null,
          flaps: (prev?.flaps ?? 0) + (changed ? 1 : 0),
        };
        // What the receiver was last told vs what is true now.
        let send: AlertItem["change"] | undefined;
        if (state === "firing" && next.sent !== "firing") {
          // At most one firing message per cooldown; a re-fire inside it waits for the window to end,
          // and is sent then only if it is still red.
          if (redFinding && (next.fired_at === null || now - next.fired_at >= this.limits.cooldownMs)) send = "firing";
        } else if (state === "ok" && next.sent === "firing") {
          send = "recovered";
        }
        if (send && finding) {
          const flaps = Math.max(0, next.flaps - 1);
          const link = findingLink(this.opts.dashboardUrl, scope.id === null ? null : scope.name, finding);
          // A recovery quotes what was wrong when it went red, not the finding's last summary.
          const summary = send === "recovered" ? (next.fired_summary ?? finding.summary) : finding.summary;
          changes.push({ item: itemFrom(finding, scope.name, send, { flaps, notObserved, link, summary }), app_id: scope.id, finding_id: finding.id, fingerprint: fp });
          next.sent = send;
          next.flaps = 0;
          if (send === "firing") {
            next.fired_at = now;
            next.fired_summary = finding.summary;
          }
        } else if (send) {
          // Nothing left to describe (the finding expired): settle silently.
          next.sent = send;
          next.flaps = 0;
        }
        if (!prev || changed || next.sent !== prev.sent || next.flaps !== prev.flaps || next.fired_at !== prev.fired_at || next.finding_id !== prev.finding_id ||
          next.fired_summary !== prev.fired_summary) {
          states.push(next);
        }
      }
    }
    return { states, changes };
  }

  /** One message per channel for this sweep's changes, minus the channel's own failure; capped per hour. */
  private messages(changes: readonly Change[], now: number): DeliveryInput[] {
    if (!changes.length) return [];
    const out: DeliveryInput[] = [];
    for (const lane of this.lanes.values()) {
      const name = lane.channel.name;
      const mine = changes.filter((c) => c.fingerprint !== deliveryFailedFingerprint(name));
      if (!mine.length) continue;
      const sentThisHour = this.store.deliveriesSince(name, now - HOUR_MS);
      const stormed = sentThisHour >= this.limits.perChannelPerHour;
      const kind: DeliveryInput["kind"] = sentThisHour === this.limits.perChannelPerHour ? "storm" : "alert";
      const delivery_id = randomUUID();
      const message: AlertMessage = {
        version: 1,
        delivery_id,
        kind,
        created_at: now,
        items: mine.slice(0, this.limits.maxItems).map((c) => c.item),
        more: Math.max(0, mine.length - this.limits.maxItems),
      };
      out.push({
        delivery_id,
        channel: name,
        kind,
        payload: JSON.stringify(message),
        // Past the cap (after one storm message) messages are recorded for the dashboard, not sent.
        status: stormed && kind !== "storm" ? "suppressed" : "pending",
        items: mine.map((c) => ({ app_id: c.app_id, finding_id: c.finding_id, fingerprint: c.fingerprint, change: c.item.change })),
      });
    }
    return out;
  }

  private enqueue(lane: Lane, d: PendingDelivery): void {
    if (lane.queue.length >= this.limits.queueMax) {
      const oldest = lane.queue.shift()!;
      this.giveUp(oldest, "QueueFull");
    }
    lane.queue.push(d);
  }

  private giveUp(d: Pick<PendingDelivery, "id" | "channel">, error: string): void {
    try {
      this.store.recordAttempt(d.id, d.channel, { ok: false, error, attempted: false });
    } catch (err) {
      this.log(`alerts: could not record a message (${errorClass(err)})`);
    }
    this.log(`alerts: ${d.channel} message given up (${error})`);
  }

  /**
   * Send the next due message of a channel; one at a time, never blocking the
   * caller. `waited`: the timer set for this message fired, so it is due.
   */
  private pump(lane: Lane, waited?: number): void {
    if (lane.busy || this.stopped) return;
    clearTimeout(lane.timer);
    lane.timer = undefined;
    if (!lane.queue.length) return;
    const now = this.now();
    lane.queue.sort((a, b) => (a.next_attempt_at ?? 0) - (b.next_attempt_at ?? 0) || a.id - b.id);
    const next = lane.queue[0]!;
    const due = next.next_attempt_at ?? now;
    if (due > now && waited !== next.id) {
      lane.timer = setTimeout(() => this.pump(lane, next.id), due - now);
      lane.timer.unref();
      return;
    }
    lane.queue.shift();
    lane.busy = true;
    lane.inflight = this.attempt(lane, next).finally(() => {
      lane.busy = false;
      lane.inflight = undefined;
      this.pump(lane);
    });
  }

  private async attempt(lane: Lane, d: PendingDelivery): Promise<void> {
    let result: SendResult;
    try {
      result = await lane.channel.send(JSON.parse(d.payload) as AlertMessage);
    } catch (err) {
      result = { ok: false, error: errorClass(err) };
    }
    const attempts = d.attempts + 1;
    const delays = this.limits.retryDelaysMs;
    const retryAt = !result.ok && attempts <= delays.length ? this.now() + delays[attempts - 1]! : undefined;
    try {
      this.store.recordAttempt(d.id, d.channel, {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.code !== undefined ? { code: result.code } : {}),
        ...(retryAt !== undefined ? { retryAt } : {}),
      });
    } catch (err) {
      this.log(`alerts: could not record a delivery (${errorClass(err)})`);
    }
    if (result.ok) return;
    const why = `${result.error ?? "Error"}${result.code !== undefined ? ` ${result.code}` : ""}`;
    if (retryAt !== undefined) {
      this.log(`alerts: ${d.channel} attempt ${attempts} failed (${why}); retrying in ${Math.round((retryAt - this.now()) / 1000)} s`);
      this.enqueue(lane, { ...d, attempts, next_attempt_at: retryAt });
    } else {
      this.log(`alerts: ${d.channel} message given up after ${attempts} attempts (${why})`);
    }
  }
}

/**
 * `npm run alerts:test`: one sample message to each channel, one attempt
 * each, recorded as kind "test" (shown on the dashboard; counts towards a
 * channel's failure streak like any attempt) and audited.
 */
export async function sendTestAlert(store: Store, channels: readonly Channel[], dashboardUrl?: URL, now: () => number = Date.now): Promise<{ channel: ChannelName; result: SendResult }[]> {
  const out: { channel: ChannelName; result: SendResult }[] = [];
  for (const channel of channels) {
    const delivery_id = randomUUID();
    const message = testMessage(dashboardUrl, now(), delivery_id);
    const [id] = store.applyAlerts([], [{ delivery_id, channel: channel.name, kind: "test", payload: JSON.stringify(message), status: "pending", items: [] }]);
    let result: SendResult;
    try {
      result = await channel.send(message);
    } catch (err) {
      result = { ok: false, error: errorClass(err) };
    }
    store.recordAttempt(id!, channel.name, { ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.code !== undefined ? { code: result.code } : {}) });
    out.push({ channel: channel.name, result });
  }
  store.auditAction("cli", "alerts.test", { channels: out.map((o) => ({ channel: o.channel, ok: o.result.ok })) });
  return out;
}
