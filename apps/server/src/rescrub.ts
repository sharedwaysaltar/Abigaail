// The server half of the scrubber (DECISIONS #104). Every error message is
// scrubbed again here, with the server's rules and the hosts this app is known
// to call, before it is stored: the server is the authority, whatever the SDK
// did. Text the SDK sent that is not a fixed point of these rules (an older
// SDK, a different host set, or a forged batch) is stored as the server
// scrubbed it and counted, never rejected (#19), and never logged.

import { scrub, SCRUB_VERSION, type AbigaailEvent, type ErrorEvent } from "@abigaail/schema";
import type { Store } from "@abigaail/store";

const DAY_MS = 86_400_000;

export const RESCRUB = {
  /** Rolled-up hosts this far back, plus raw outbound events of the last recentMs. */
  hostHistoryMs: 28 * DAY_MS,
  recentMs: 3 * 3_600_000,
  /** Hosts remembered per app (as the SDK's MAX_KNOWN_HOSTS). */
  maxHosts: 500,
  /** Host sets are reloaded from the store this often. */
  reloadMs: 10 * 60_000,
};

export class Rescrubber {
  private readonly hosts = new Map<string, { set: Set<string>; loadedAt: number }>();
  private readonly mismatches = new Map<string, { app_id: string; minute: number; n: number }>();

  constructor(private readonly store: Store, private readonly now: () => number) {}

  /** The app's outbound hosts, loaded from the store at most every RESCRUB.reloadMs. */
  private hostsFor(appId: string): Set<string> {
    const t = this.now();
    let entry = this.hosts.get(appId);
    if (!entry || t - entry.loadedAt > RESCRUB.reloadMs) {
      const loaded = this.store.outboundHosts(appId, t - RESCRUB.hostHistoryMs, t, RESCRUB.recentMs);
      const set = new Set([...loaded].slice(0, RESCRUB.maxHosts));
      // Hosts learned from batches since the last load are kept.
      for (const h of entry?.set ?? []) if (set.size < RESCRUB.maxHosts) set.add(h);
      entry = { set, loadedAt: t };
      this.hosts.set(appId, entry);
    }
    return entry.set;
  }

  /**
   * Scrub one batch's messages in place, after learning its own outbound
   * hosts. Returns how many texts changed (also counted for the store).
   */
  apply(appId: string, events: AbigaailEvent[]): number {
    const hosts = this.hostsFor(appId);
    for (const e of events) {
      if (e.type === "outbound" && hosts.size < RESCRUB.maxHosts && e.host !== "ip-literal" && e.host !== "invalid-host") hosts.add(e.host);
    }
    const opts = { knownHost: (h: string) => hosts.has(h) };
    let changed = 0;
    for (const e of events) {
      if (e.type !== "error") continue;
      const err = e as ErrorEvent;
      for (const field of ["message", "cause_message"] as const) {
        const sent = err[field];
        if (sent === undefined) continue;
        const kept = scrub(sent, opts);
        if (kept !== sent) changed++;
        if (kept === undefined) delete err[field];
        else err[field] = kept;
      }
      if (err.message !== undefined || err.cause_message !== undefined) err.scrub_version = SCRUB_VERSION;
      else delete err.scrub_version;
    }
    if (changed) {
      const minute = Math.floor(this.now() / 60_000) * 60_000;
      const k = `${appId}|${minute}`;
      const m = this.mismatches.get(k);
      if (m) m.n += changed;
      else this.mismatches.set(k, { app_id: appId, minute, n: changed });
    }
    return changed;
  }

  /** Write the counts (once a minute and on close, with the refusal counts). */
  flush(): void {
    if (!this.mismatches.size) return;
    const rows = [...this.mismatches.values()];
    this.mismatches.clear();
    this.store.addScrubMismatches(rows);
  }
}
