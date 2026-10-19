// Relay from the server's loopback live feed to one signed-in browser
// (DECISIONS #73). Pull-based: each pull() reads one chunk from upstream, so a
// slow or paused browser stops the reads, the upstream socket fills, and the
// server's drop-not-queue logic applies there. The relay holds at most one chunk.

const KEY = Symbol.for("abigaail.dashboard.live");

export const RELAY = {
  /** How often an open stream re-checks its session (read-only). */
  recheckMs: 60_000,
  /** Open streams per session and in total in this process. */
  perSession: 2,
  total: 8,
};

interface Relay {
  sessionHash: string;
  close: () => void;
}

type G = typeof globalThis & { [KEY]?: Set<Relay> };
const relays = (): Set<Relay> => ((globalThis as G)[KEY] ??= new Set());

/** Open streams, in total or for one session. */
export function openStreams(sessionHash?: string): number {
  let n = 0;
  for (const r of relays()) if (sessionHash === undefined || r.sessionHash === sessionHash) n++;
  return n;
}

/** End a session's streams at once (sign-out). Other sessions' streams stay open. */
export function closeLiveStreams(sessionHash: string): void {
  for (const r of [...relays()]) if (r.sessionHash === sessionHash) r.close();
}

export interface RelayOptions {
  sessionHash: string;
  /** Opens the upstream stream (the server's /live), with this abort signal. */
  upstream: (signal: AbortSignal) => Promise<Response>;
  /** Whether the session is still valid. Must not refresh it. */
  stillValid: () => boolean;
  /** The browser's request: aborting it ends the relay. */
  signal?: AbortSignal;
  limits?: Partial<typeof RELAY>;
}

export type RelayResult = { ok: true; stream: ReadableStream<Uint8Array> } | { ok: false; status: 429 | 502 | 503 };

export async function openRelay(opts: RelayOptions): Promise<RelayResult> {
  const limits = { ...RELAY, ...opts.limits };
  if (openStreams() >= limits.total || openStreams(opts.sessionHash) >= limits.perSession) return { ok: false, status: 429 };

  const ac = new AbortController();
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  // The slot is taken before the upstream request, so racing opens cannot pass the caps.
  const relay: Relay = { sessionHash: opts.sessionHash, close: () => finish() };
  relays().add(relay);

  function finish(): void {
    if (done) return;
    done = true;
    relays().delete(relay);
    if (timer) clearInterval(timer);
    ac.abort();
    reader?.cancel().catch(() => {});
    try {
      controller?.close();
    } catch {
      // Already closed or cancelled by the browser.
    }
  }

  if (opts.signal?.aborted) {
    finish();
    return { ok: false, status: 502 };
  }
  opts.signal?.addEventListener("abort", finish, { once: true });

  let res: Response;
  try {
    res = await opts.upstream(ac.signal);
  } catch {
    finish();
    return { ok: false, status: 502 };
  }
  if (!res.ok || !res.body) {
    res.body?.cancel().catch(() => {});
    finish();
    // A refused token means the two processes disagree on ABIGAAIL_LIVE_TOKEN: the view is off.
    return { ok: false, status: res.status === 401 || res.status === 503 ? 503 : res.status === 429 ? 429 : 502 };
  }
  if (done) return { ok: false, status: 502 };
  reader = res.body.getReader();
  const upstream = reader;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        timer = setInterval(() => {
          if (!opts.stillValid()) finish();
        }, limits.recheckMs);
        (timer as { unref?: () => void }).unref?.();
      },
      // One upstream chunk per pull: nothing reads ahead of the browser.
      async pull(c) {
        try {
          const { done: end, value } = await upstream.read();
          if (end) finish();
          else if (!done) c.enqueue(value);
        } catch {
          finish();
        }
      },
      cancel() {
        finish();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
  return { ok: true, stream };
}

/** Headers of the stream we send. Fixed: nothing from upstream is copied. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};
