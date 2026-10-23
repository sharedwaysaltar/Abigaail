import { FEATURE_RE, MAX_FEATURES, type Batch } from "@abigaail/schema";

export type SendResult =
  /** Accepted. */
  | "ok"
  /** Ingest rejected the batch as invalid (4xx). Retrying will not help: drop it. */
  | "rejected"
  /** Network error, timeout, 401/403, 429 or 5xx. Counts against the circuit breaker. */
  | "failed";

/** A send result plus the optional schema features the server announced (DECISIONS #110). */
export interface SendOutcome {
  result: SendResult;
  features?: readonly string[];
}

/** A plain result means the server announced no features: the SDK sends the base schema only. */
export type Transport = (batch: Batch, signal: AbortSignal) => Promise<SendResult | SendOutcome>;

/** Most of a 202 body read: the answer is a few dozen bytes, anything longer is not ours. */
const MAX_ANSWER_BYTES = 1024;

/** The features list of a 202 body, each one pattern-checked; [] for anything else. */
export function parseFeatures(text: string): string[] {
  try {
    const body: unknown = JSON.parse(text);
    const list = (body as { features?: unknown } | null)?.features;
    if (!Array.isArray(list)) return [];
    return list.filter((f): f is string => typeof f === "string" && FEATURE_RE.test(f)).slice(0, MAX_FEATURES);
  } catch {
    return [];
  }
}

/** At most `max` bytes of a response body as text, or undefined if it is longer. */
async function readSmall(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return undefined;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

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
      if (res.ok) {
        // The 202 names the schema features this server accepts; a long or odd body announces none.
        const text = await readSmall(res, MAX_ANSWER_BYTES).catch(() => undefined);
        return { result: "ok", features: text === undefined ? [] : parseFeatures(text) };
      }
      // Free the socket; an error body is not needed.
      res.body?.cancel().catch(() => {});
      // 401/403 (bad key) also count as failures so the breaker backs off
      // instead of retrying a misconfigured key every flush.
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) return "failed";
      return "rejected";
    } catch {
      return "failed";
    }
  };
}
