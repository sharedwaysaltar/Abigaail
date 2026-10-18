import { afterEach, describe, expect, it } from "vitest";
import { thresholds } from "@abigaail/server";
import { batch, post, requestEvent, startServer, T0, type TestServer } from "./helpers.js";

let s: TestServer | undefined;

afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("/healthz", () => {
  it("answers 503 with no details when the Watchdog is stale", async () => {
    let fresh = true;
    s = await startServer({ healthz: () => ({ ok: fresh }) });
    expect(await (await fetch(`${s.url}/healthz`)).json()).toEqual({ ok: true });
    fresh = false;
    const res = await fetch(`${s.url}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('answers 200 with agents: "off" when the runner is disabled', async () => {
    s = await startServer({ healthz: () => ({ ok: true, agents: "off" }) });
    const res = await fetch(`${s.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, agents: "off" });
  });
});

describe("ingest refusal counts", () => {
  it("counts 401 under '', 403 and 429 per app, per minute, flushed in batches", async () => {
    s = await startServer({ rejectionFlushMs: 20, appRate: { perSec: 0.001, burst: 1 } });
    const { key: liveKey, app: live } = s.store.createApp("live", "test");
    const { key: deadKey, app: dead } = s.store.createApp("dead", "test");
    s.store.disableApp("dead", "test");

    expect((await post(s, batch([requestEvent()]), { key: "abk_unknown" })).status).toBe(401);
    expect((await post(s, batch([requestEvent()]), { key: deadKey })).status).toBe(403);
    expect((await post(s, batch([requestEvent()]), { key: deadKey })).status).toBe(403);
    expect((await post(s, batch([requestEvent()]), { key: liveKey })).status).toBe(202);
    expect((await post(s, batch([requestEvent()]), { key: liveKey })).status).toBe(429);
    // Nothing is written per request: counts land on the next flush.
    await new Promise((r) => setTimeout(r, 60));

    expect(s.store.ingestRejections("", T0)).toEqual([{ status: 401, n: 1 }]);
    expect(s.store.ingestRejections(dead.id, T0)).toEqual([{ status: 403, n: 2 }]);
    expect(s.store.ingestRejections(live.id, T0)).toEqual([{ status: 429, n: 1 }]);
  });

  it("flushes what is left when the server closes", async () => {
    s = await startServer({ rejectionFlushMs: 60_000 });
    await post(s, batch([requestEvent()]), { key: "abk_unknown" });
    expect(s.store.ingestRejections("", T0)).toEqual([]);
    await s.stopListening();
    expect(s.store.ingestRejections("", T0)).toEqual([{ status: 401, n: 1 }]);
  });
});

describe("evaluation lag", () => {
  /**
   * An event that happened 10 s before a minute boundary M is sent 30 s later
   * (SDK queue, retry) and arrives at M+20 s. Agent ticks run at M+1 s,
   * M+61 s and M+121 s, each judging the minute ending at windowEnd(tick).
   * Returns the count each tick saw.
   */
  async function simulate(server: TestServer, lagMs: number): Promise<number[]> {
    const { key, app } = server.store.createApp(`lag-${lagMs}`, "test");
    const M = T0 + 60_000;
    const seen: number[] = [];
    const tick = (at: number) => {
      server.clock.now = at;
      const end = thresholds.windowEnd(at, lagMs);
      seen.push(server.store.statsFor(app.id, "route", end - 60_000, end).reduce((sum, r) => sum + r.n, 0));
    };
    tick(M + 1_000);
    server.clock.now = M + 20_000;
    const happened = M - 10_000;
    const res = await post(server, batch([requestEvent({ client_ts: happened })], { sent_at: happened + 30_000 }), { key });
    expect(res.status).toBe(202);
    expect(server.store.recentEvents(app.id)[0]!.ts).toBe(happened);
    tick(M + 61_000);
    tick(M + 121_000);
    return seen;
  }

  it("an event arriving 20 s late is counted once, in the window it belongs to", async () => {
    s = await startServer();
    expect(await simulate(s, thresholds.EVAL_LAG_MS)).toEqual([0, 1, 0]);
  });

  it("without the lag the same event falls between windows and is never judged", async () => {
    s = await startServer();
    expect(await simulate(s, 0)).toEqual([0, 0, 0]);
  });
});
