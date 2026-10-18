import { afterEach, describe, expect, it } from "vitest";
import { batch, rawRequest, requestEvent, startServer, type TestServer } from "./helpers.js";

let s: TestServer | undefined;

afterEach(async () => {
  await s?.close();
  s = undefined;
});

const head = (lines: string[]) => `${lines.join("\r\n")}\r\n\r\n`;

describe("oversized bodies", () => {
  it("rejects a declared oversize body with 413 and closes without reading it", async () => {
    s = await startServer();
    const { key } = s.store.createApp("demo", "test");
    const r = await rawRequest(
      s.port,
      head([
        "POST /ingest HTTP/1.1",
        "Host: localhost",
        "Content-Type: application/json",
        `X-Abigaail-Key: ${key}`,
        "Content-Length: 10000000",
      ]),
    );
    expect(r.response).toMatch(/^HTTP\/1\.1 413 /);
    expect(r.response.toLowerCase()).toContain("connection: close");
    expect(r.closedByServer).toBe(true);
  });

  it("rejects a streamed (chunked) body once it passes the cap, and closes", async () => {
    s = await startServer({ maxBodyBytes: 64 * 1024 });
    const { key, app } = s.store.createApp("demo", "test");
    const piece = Buffer.alloc(16 * 1024, "a");
    const chunk = Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n")]);
    const r = await rawRequest(
      s.port,
      head([
        "POST /ingest HTTP/1.1",
        "Host: localhost",
        "Content-Type: application/json",
        `X-Abigaail-Key: ${key}`,
        "Transfer-Encoding: chunked",
      ]),
      { chunks: Array(40).fill(chunk), everyMs: 5 },
    );
    expect(r.response).toMatch(/^HTTP\/1\.1 413 /);
    expect(r.closedByServer).toBe(true);
    expect(s.store.countEvents(app.id)).toBe(0);
  });

  it("does not read the body of an unauthenticated request", async () => {
    s = await startServer();
    const r = await rawRequest(
      s.port,
      head(["POST /ingest HTTP/1.1", "Host: localhost", "Content-Type: application/json", "Content-Length: 400000"]),
    );
    expect(r.response).toMatch(/^HTTP\/1\.1 401 /);
    expect(r.closedByServer).toBe(true);
  });
});

describe("slow clients", () => {
  it("cuts off a slow upload with the request timeout and stores nothing", async () => {
    s = await startServer({ timeouts: { headersMs: 200, requestMs: 300, checkIntervalMs: 50 } });
    const { key, app } = s.store.createApp("demo", "test");
    const body = JSON.stringify(batch([requestEvent()]));
    // Dribble one byte every 50ms: the full body would take far longer than 300ms.
    const r = await rawRequest(
      s.port,
      head([
        "POST /ingest HTTP/1.1",
        "Host: localhost",
        "Content-Type: application/json",
        `X-Abigaail-Key: ${key}`,
        `Content-Length: ${Buffer.byteLength(body)}`,
      ]),
      { chunks: body.split(""), everyMs: 50, giveUpMs: 3000 },
    );
    expect(r.closedByServer).toBe(true);
    expect(r.elapsedMs).toBeLessThan(1500);
    expect(s.store.countEvents(app.id)).toBe(0);
  });

  it("cuts off a client that never finishes its headers", async () => {
    s = await startServer({ timeouts: { headersMs: 200, requestMs: 300, checkIntervalMs: 50 } });
    const r = await rawRequest(s.port, "POST /ingest HTTP/1.1\r\nHost: localhost\r\n", { giveUpMs: 3000 });
    expect(r.closedByServer).toBe(true);
    expect(r.elapsedMs).toBeLessThan(1500);
  });
});
