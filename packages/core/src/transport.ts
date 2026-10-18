import type { Batch } from "@abigaail/schema";

export type SendResult =
  /** Accepted. */
  | "ok"
  /** Ingest rejected the batch as invalid (4xx). Retrying will not help: drop it. */
  | "rejected"
  /** Network error, timeout, 401/403, 429 or 5xx. Counts against the circuit breaker. */
  | "failed";

export type Transport = (batch: Batch, signal: AbortSignal) => Promise<SendResult>;

export interface FetchTransportOptions {
  endpoint: string;
  ingestKey: string;
  fetch?: typeof globalThis.fetch;
}

/** POSTs a batch to the ingest endpoint. Never rejects. */
export function fetchTransport(opts: FetchTransportOptions): Transport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return async (batch, signal) => {
    try {
      const res = await doFetch(opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-abigaail-key": opts.ingestKey },
        body: JSON.stringify(batch),
        signal,
      });
      // Free the socket; the body is not needed.
      res.body?.cancel().catch(() => {});
      if (res.ok) return "ok";
      // 401/403 (bad key) also count as failures so the breaker backs off
      // instead of retrying a misconfigured key every flush.
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) return "failed";
      return "rejected";
    } catch {
      return "failed";
    }
  };
}
