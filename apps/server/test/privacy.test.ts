import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visitorHash } from "@abigaail/server";
import { batch, post, requestEvent, startServer, T0, type TestServer } from "./helpers.js";

// Distinctive markers, so the scans cannot match legitimate stored strings
// (like the browser family "chrome") and a leak cannot hide behind common text.
const IP = "203.0.113.77";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 abgtest-9f3k2";
const UA_MARKER = "abgtest-9f3k2";
const DAY = 24 * 60 * 60 * 1000;

let s: TestServer;
let key: string;
let appId: string;

beforeEach(async () => {
  s = await startServer();
  ({ key, app: { id: appId } } = s.store.createApp("app-a", "test"));
});

afterEach(async () => {
  await s.close();
});

/** The current salt file contents: [day, salt]. */
const saltFile = (): [string, Buffer] => {
  const bytes = readFileSync(s.saltPath);
  return [bytes.toString("latin1", 0, 10), Buffer.from(bytes.subarray(10, 42))];
};

const visit = (transient: Record<string, string> = { ip: IP, ua: UA }) => requestEvent({ transient });

async function hashesFor(k: string, events: unknown[], extra: Record<string, unknown> = {}): Promise<(string | null)[]> {
  const res = await post(s, batch(events, extra), { key: k });
  expect(res.status).toBe(202);
  const ids = new Set(events.map((e) => (e as { event_id: string }).event_id));
  return s
    .raw<{ event_id: string; visitor_hash: string | null; client_ts: number }>(
      "SELECT event_id, visitor_hash, client_ts FROM events ORDER BY client_ts, event_id",
    )
    .filter((r) => ids.has(r.event_id))
    .map((r) => r.visitor_hash);
}

describe("transient IP and user agent never reach storage", () => {
  it("leaves no trace in any table, the database file or its WAL file", async () => {
    const res = await post(s, batch([visit(), visit(), visit({ ip: IP })]), { key });
    expect(res.status).toBe(202);

    // Derived values did arrive, so the transient data was used.
    const rows = s.raw<{ visitor_hash: string | null; browser: string | null }>("SELECT visitor_hash, browser FROM events");
    expect(rows.every((r) => r.visitor_hash && /^[0-9a-f]{32}$/.test(r.visitor_hash))).toBe(true);
    expect(rows.some((r) => r.browser === "chrome")).toBe(true);

    // Every column of every table.
    const tables = s.raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["apps", "events", "deploys", "audit_log"]));
    for (const table of tables) {
      const dump = JSON.stringify(s.raw(`SELECT * FROM "${table}"`));
      expect(dump, table).not.toContain(IP);
      expect(dump, table).not.toContain(UA_MARKER);
    }

    // Raw bytes: recent writes sit in the -wal file until a checkpoint.
    const scan = (label: string) => {
      for (const path of [s.dbPath, `${s.dbPath}-wal`]) {
        if (!existsSync(path)) continue;
        const bytes = readFileSync(path);
        expect(bytes.includes(IP), `${label} ${path}`).toBe(false);
        expect(bytes.includes(UA_MARKER), `${label} ${path}`).toBe(false);
      }
    };
    expect(statSync(`${s.dbPath}-wal`).size).toBeGreaterThan(0);
    scan("before checkpoint");
    s.store.checkpoint();
    scan("after checkpoint");
  });

  it("never puts the salt in the database file or its WAL file", async () => {
    await post(s, batch([visit(), visit({ ip: "198.51.100.9", ua: UA })]), { key });
    const [, salt] = saltFile();
    const scan = (label: string) => {
      for (const path of [s.dbPath, `${s.dbPath}-wal`]) {
        if (!existsSync(path)) continue;
        const bytes = readFileSync(path);
        expect(bytes.includes(salt), `${label} ${path}`).toBe(false);
        expect(bytes.includes(Buffer.from(salt.toString("hex"))), `${label} ${path} (hex)`).toBe(false);
      }
    };
    expect(statSync(`${s.dbPath}-wal`).size).toBeGreaterThan(0);
    scan("before checkpoint");
    s.store.checkpoint();
    scan("after checkpoint");
  });
});

describe("visitor hash", () => {
  it("is stable for the same visitor, app and UTC day", async () => {
    const [a, b] = await hashesFor(key, [visit(), visit()]);
    s.clock.now = T0 + 60 * 60 * 1000;
    const [c] = await hashesFor(key, [visit()]);
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  it("differs for the same visitor in two apps (no cross-tenant linking)", async () => {
    const other = s.store.createApp("app-b", "test").key;
    const [inA] = await hashesFor(key, [visit()]);
    const [inB] = await hashesFor(other, [visit()]);
    expect(inA).toMatch(/^[0-9a-f]{32}$/);
    expect(inB).toMatch(/^[0-9a-f]{32}$/);
    expect(inA).not.toBe(inB);
  });

  it("changes the next UTC day, hashing with the new salt from salt.bin", async () => {
    const [today] = await hashesFor(key, [visit()]);
    const [, oldSalt] = saltFile();
    s.clock.now = T0 + DAY;
    const [tomorrow] = await hashesFor(key, [visit()]);
    const [day, newSalt] = saltFile();
    expect(day).toBe("2026-10-19");
    expect(newSalt.equals(oldSalt)).toBe(false);
    expect(tomorrow).not.toBe(today);
    expect(tomorrow).toBe(visitorHash(newSalt, appId, IP, UA));
  });

  it("takes the salt day from receive time, not event time", async () => {
    const midnight = Date.UTC(2026, 9, 19);
    s.clock.now = midnight + 5_000;
    const [fresh] = await hashesFor(key, [requestEvent({ client_ts: 1_000, transient: { ip: IP, ua: UA } })], { sent_at: 1_000 });
    // A retried batch whose event happened 10 minutes ago, i.e. yesterday (UTC).
    s.clock.now = midnight + 6_000;
    const retried = requestEvent({ client_ts: 1_000, transient: { ip: IP, ua: UA } });
    const [late] = await hashesFor(key, [retried], { sent_at: 1_000 + 10 * 60_000 });
    expect(s.store.recentEvents(appId).find((e) => e.event_id === retried.event_id)!.ts).toBeLessThan(midnight);
    expect(late).toBe(fresh);
    expect(saltFile()[0]).toBe("2026-10-19");
  });

  it("is not a plain hash of the IP", async () => {
    const [h] = await hashesFor(key, [visit()]);
    expect(h).not.toBe(createHash("sha256").update(IP).digest("hex").slice(0, 32));
    expect(h).not.toBe(createHash("sha256").update(`${IP}${UA}`).digest("hex").slice(0, 32));
  });

  it("never uses the connection's IP: no transient.ip means no hash", async () => {
    // The request itself comes from 127.0.0.1; that address must be ignored.
    const [h] = await hashesFor(key, [visit({ ua: UA })]);
    expect(h).toBeNull();
  });
});

describe("error messages are scrubbed again by the server (DECISIONS #104)", () => {
  const errorEvent = (o: Record<string, unknown>) => ({ type: "error", event_id: uuidFor(), client_ts: T0, error_type: "Error", handled: true, ...o });
  let n = 0;
  const uuidFor = () => `00000000-0000-4000-8000-${String(900_000 + ++n).padStart(12, "0")}`;
  const stored = () => s.raw<{ attrs: string }>("SELECT attrs FROM events WHERE type = 'error' ORDER BY event_id").map((r) => JSON.parse(r.attrs) as Record<string, unknown>);

  it("a forged batch that bypasses the SDK stores nothing personal, in rows, the file or its WAL", async () => {
    const forged = [
      "User jane.doe@example.com not found for 203.0.113.77",
      "Order for Hannah Okafor failed: card 4242 4242 4242 4242",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJlLXNlY3JldA rejected for the user",
      // A fake key, built from parts so the source holds no key-shaped string.
      `Login failed for the user ${["sk", "live", "51H8xYzAbCdEfGhIjKlMnOp"].join("_")}`,
    ];
    const res = await post(s, batch(forged.map((message, i) => errorEvent({ message, cause_message: forged[(i + 1) % forged.length] }))), { key });
    expect(res.status).toBe(202);
    const rows = stored();
    expect(rows.map((r) => r.message)).toEqual([
      "User <email> not found for <ip>",
      "Order for <word> <word> failed: card <card>",
      "token <jwt> rejected for the user",
      "Login failed for the user <key>",
    ]);
    expect(rows.every((r) => r.scrub_version === 1)).toBe(true);
    const markers = ["jane.doe", "203.0.113.77", "Hannah", "Okafor", "4242 4242", "eyJzdWIiOiJqYW5lIn0", "sk_live_51H8"];
    for (const table of s.raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name)) {
      const dump = JSON.stringify(s.raw(`SELECT * FROM "${table}"`));
      for (const m of markers) expect(dump, `${table} ${m}`).not.toContain(m);
    }
    for (const path of [s.dbPath, `${s.dbPath}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      for (const m of markers) expect(bytes.includes(m), `${path} ${m}`).toBe(false);
    }
    // Every changed text is counted (never stored): 4 messages and 4 causes.
    s.clock.now += 60_000;
    await s.stopListening();
    expect(s.store.scrubMismatches(appId, 0)).toBe(8);
  });

  it("text the SDK scrubbed with the same rules is stored as sent and not counted", async () => {
    const res = await post(s, batch([errorEvent({ message: "User <email> not found", code: "P2025", scrub_version: 1 })]), { key });
    expect(res.status).toBe(202);
    expect(stored()[0]).toMatchObject({ message: "User <email> not found", code: "P2025", scrub_version: 1 });
    await s.stopListening();
    expect(s.store.scrubMismatches(appId, 0)).toBe(0);
  });

  it("a hostname is kept only if this app is known to call it: from stored outbound events or the same batch", async () => {
    const msg = "getaddrinfo ENOTFOUND api.payments.example";
    await post(s, batch([errorEvent({ message: msg })]), { key });
    const outbound = { type: "outbound", event_id: uuidFor(), client_ts: T0, host: "api.payments.example", method: "GET", duration_ms: 3, outcome: "error", error_code: "ENOTFOUND" };
    // The same batch teaches the server the host before its errors are scrubbed.
    await post(s, batch([outbound, errorEvent({ message: msg })]), { key });
    // Another app has never called it.
    const other = s.store.createApp("app-b", "test");
    await post(s, batch([errorEvent({ message: msg })]), { key: other.key });
    const rows = s.raw<{ app_id: string; attrs: string }>("SELECT app_id, attrs FROM events WHERE type = 'error' ORDER BY event_id").map((r) => [r.app_id, JSON.parse(r.attrs).message]);
    expect(rows).toEqual([
      [appId, "getaddrinfo ENOTFOUND <host>"],
      [appId, msg],
      [other.app.id, "getaddrinfo ENOTFOUND <host>"],
    ]);
    expect(JSON.parse(s.raw<{ attrs: string }>("SELECT attrs FROM events WHERE type = 'outbound'")[0]!.attrs)).toMatchObject({ error_code: "ENOTFOUND" });
  });

  it("refuses a code that is not one, as any invalid field (the SDK never sends one)", async () => {
    const res = await post(s, batch([errorEvent({ code: "jane@example.com" })]), { key });
    expect(res.status).toBe(400);
    const long = await post(s, batch([errorEvent({ message: "x".repeat(201) })]), { key });
    expect(long.status).toBe(400);
  });
});
