import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer, openSaltFile, type ServerOptions } from "@abigaail/server";
import { openStore, type Store } from "@abigaail/store";

export const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

export interface TestServer {
  store: Store;
  dbPath: string;
  saltPath: string;
  port: number;
  url: string;
  /** Server clock; tests move it by assigning. */
  clock: { now: number };
  /** Query the database file over a separate connection, bypassing the Store API. */
  raw<T>(sql: string): T[];
  /** Close the HTTP server only; the store stays open until close(). */
  stopListening(): Promise<void>;
  close(): Promise<void>;
}

export async function startServer(opts: Partial<Omit<ServerOptions, "store" | "now">> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "abigaail-server-"));
  const dbPath = join(dir, "test.db");
  const saltPath = join(dir, "salt.bin");
  const clock = { now: T0 };
  const store = openStore(dbPath, { now: () => clock.now });
  const salt = opts.salt ?? openSaltFile(saltPath, () => clock.now);
  const server = createServer({ store, now: () => clock.now, log: () => {}, ...opts, salt });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    store,
    dbPath,
    saltPath,
    port,
    url: `http://127.0.0.1:${port}`,
    clock,
    raw<T>(sql: string): T[] {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return db.prepare(sql).all() as T[];
      } finally {
        db.close();
      }
    },
    async stopListening() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let n = 0;
export function uuid(): string {
  return `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

export function requestEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "request",
    event_id: uuid(),
    client_ts: T0,
    method: "GET",
    route: "/user/[id]",
    status: 200,
    duration_ms: 12,
    ...overrides,
  };
}

export function batch(events: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    sdk: { name: "@abigaail/core", version: "0.1.0" },
    release: "abc123",
    environment: "staging",
    events,
    ...overrides,
  };
}

export async function post(
  s: TestServer,
  body: unknown,
  opts: { key?: string; contentType?: string; path?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json" };
  if (opts.key !== undefined) headers["x-abigaail-key"] = opts.key;
  const res = await fetch(`${s.url}${opts.path ?? "/ingest"}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, headers: res.headers };
}

export interface RawResult {
  /** Everything the server sent back. */
  response: string;
  /** True if the server closed the connection before the helper gave up. */
  closedByServer: boolean;
  elapsedMs: number;
}

/**
 * Speak HTTP over a raw socket: write `head`, then each body chunk `everyMs`
 * apart, stopping as soon as the server answers or closes. Gives up after
 * `giveUpMs` and reports closedByServer = false.
 */
export function rawRequest(
  port: number,
  head: string,
  body: { chunks?: (string | Buffer)[]; everyMs?: number; giveUpMs?: number } = {},
): Promise<RawResult> {
  const { chunks = [], everyMs = 10, giveUpMs = 3000 } = body;
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect(port, "127.0.0.1");
    let response = "";
    let answered = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = (closedByServer: boolean) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      sock.destroy();
      resolve({ response, closedByServer, elapsedMs: Date.now() - started });
    };
    sock.on("data", (d) => {
      answered = true;
      response += d.toString("latin1");
    });
    sock.on("error", () => {});
    sock.on("close", () => settle(true));
    timers.push(setTimeout(() => settle(false), giveUpMs));
    sock.write(head);
    chunks.forEach((chunk, i) => {
      timers.push(
        setTimeout(() => {
          if (!answered && !sock.destroyed && sock.writable) sock.write(chunk);
        }, everyMs * (i + 1)),
      );
    });
  });
}
