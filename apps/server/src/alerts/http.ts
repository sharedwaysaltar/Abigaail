// One HTTP request to a checked URL (url.ts): every resolved address is
// checked before the socket connects, redirects are never followed, at most
// a few KiB of the answer is read, and one timeout covers the whole exchange.
// No keep-alive pool, so nothing outlives the request.

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { errorClass } from "../agents/evaluate.js";
import { checkedLookup, type UrlPolicy } from "./url.js";

/** What happened, without any text from the receiver. */
export interface SendResult {
  ok: boolean;
  /** HTTP status or SMTP response code. */
  code?: number;
  /** Error class or code only (Timeout, ECONNREFUSED, HttpStatus, UrlRefused, EAUTH ...). */
  error?: string;
}

export interface RequestOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  policy?: UrlPolicy;
  /** Tests only: replaces dns.lookup. */
  resolve?: (hostname: string, options: LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
  /** Tests only: extra CA certificates. */
  ca?: string;
}

/** An error's code (ECONNREFUSED, EAUTH ...) or class name; never its message, which can carry the receiver's text. */
export function failureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : errorClass(err);
}

class Timeout extends Error {
  override name = "Timeout";
}

/** Send one request. Never throws; a 2xx answer is ok, anything else (a redirect too) is not. */
export function send(url: URL, o: RequestOptions): Promise<SendResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const body = o.body === undefined ? undefined : Buffer.from(o.body, "utf8");
    const make = url.protocol === "https:" ? httpsRequest : httpRequest;
    let req: ReturnType<typeof httpRequest>;
    try {
      req = make(url, {
        method: o.method,
        agent: false,
        headers: { ...o.headers, ...(body ? { "content-length": String(body.length) } : {}), "user-agent": "Abigaail-Alerts/1" },
        lookup: checkedLookup(url, o.policy, o.resolve),
        ...(o.ca ? { ca: o.ca } : {}),
      });
    } catch (err) {
      return finish({ ok: false, error: failureCode(err) });
    }
    timer = setTimeout(() => req.destroy(new Timeout()), o.timeoutMs);
    timer.unref();
    req.on("error", (err) => finish({ ok: false, error: failureCode(err) }));
    req.on("response", (res: IncomingMessage) => {
      const code = res.statusCode ?? 0;
      let read = 0;
      // Read (and discard) a little of the answer, then close: a receiver cannot make us buffer.
      res.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read > o.maxBytes) res.destroy();
      });
      const done = () => {
        finish(code >= 200 && code < 300 ? { ok: true, code } : { ok: false, code, error: "HttpStatus" });
        req.destroy();
      };
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
    });
    req.end(body);
  });
}
