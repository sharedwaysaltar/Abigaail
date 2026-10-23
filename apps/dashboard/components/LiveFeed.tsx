"use client";

import type { LiveEvent } from "@abigaail/store";
import { useEffect, useRef, useState } from "react";
import { Cause, Scrubbed } from "./Scrubbed";

// The Live view's stream reader. fetch + a stream reader rather than
// EventSource, so the status is visible: 401 and 503 stop for good ("Signed
// out", "Live view is off"); anything else reconnects with backoff. Memory is
// bounded: a ring of the newest events and 60 one-second counters.

type Conn = "connecting" | "live" | "reconnecting" | "signed-out" | "off" | "busy" | "gone";
type Kind = LiveEvent["type"];

const RING = 500;
const SHOWN = 200;
const BOTS = new Set(["crawler", "ai_crawler", "automation"]);
const CONN_TEXT: Record<Conn, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  "signed-out": "Signed out",
  off: "Live view is off",
  busy: "Too many live views open",
  gone: "No such app",
};

const KIND_TEXT: Record<Kind, string> = {
  request: "Requests",
  outbound: "Outbound",
  error: "Errors",
  lifecycle: "Lifecycle",
  block: "Loop blocks",
  metric: "Metrics",
};

interface Row {
  n: number;
  e: LiveEvent;
}

interface Second {
  s: number;
  requests: number;
  errors: number;
  failed: number;
}

const hms = (ts: number) => new Date(ts).toISOString().slice(11, 19);
const dur = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const isBot = (e: LiveEvent) => e.type === "request" && ((e.bot_class !== null && BOTS.has(e.bot_class)) || !!e.flags?.length);
const failedCall = (e: LiveEvent) => e.type === "outbound" && (e.outcome !== "ok" || (e.status ?? 0) >= 500);

/** Parse complete SSE messages out of a buffer; returns what is left over. */
function parse(buf: string, on: (event: string, data: string) => void, onRetry: (ms: number) => void): string {
  let i: number;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const k = line.indexOf(":");
      const field = k < 0 ? line : line.slice(0, k);
      const value = k < 0 ? "" : line.slice(k + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "retry" && /^\d+$/.test(value)) onRetry(Number(value));
    }
    if (data.length) on(event, data.join("\n"));
  }
  // An unterminated message never grows without bound.
  return buf.length > 1_000_000 ? "" : buf;
}

function Line({ e }: { e: LiveEvent }) {
  const bot = isBot(e);
  switch (e.type) {
    case "request":
      return (
        <>
          <span className="k">request</span>
          <span className="what">
            {e.method} {e.route}
          </span>
          <span className={e.status >= 500 ? "bad" : undefined}>
            {e.status}
            {e.status >= 500 ? " 5xx" : ""}
          </span>
          <span className="r">{dur(e.duration_ms)}</span>
          {bot ? <span className="tag">{e.flags?.length ? e.flags.map((f) => (f === "scanner_path" ? "scanner" : f.replace(/_/g, " "))).join(", ") : "bot"}</span> : null}
        </>
      );
    case "outbound": {
      const bad = failedCall(e);
      return (
        <>
          <span className="k">outbound</span>
          <span className="what">
            {e.method} {e.host}
          </span>
          <span className={bad ? "bad" : undefined}>
            {e.outcome !== "ok" ? e.outcome : (e.status ?? "—")}
            {e.outcome === "ok" && (e.status ?? 0) >= 500 ? " 5xx" : ""}
          </span>
          <span className="r">{dur(e.duration_ms)}</span>
        </>
      );
    }
    case "error":
      return (
        <>
          <span className="k">error</span>
          <span className="what bad">
            {e.error_type}
            {e.code ? ` ${e.code}` : ""}
            {e.route ? ` ${e.route}` : ""}
            {e.message ? <> · <Scrubbed text={e.message} /></> : null}
            {e.cause_type || e.cause_code || e.cause_message ? <> · <Cause type={e.cause_type} code={e.cause_code} message={e.cause_message} /></> : null}
          </span>
          <span>{e.handled ? "handled" : "unhandled"}</span>
          <span className="r" />
        </>
      );
    case "metric":
      return (
        <>
          <span className="k">metric</span>
          <span className="what">{e.name.replace(/_/g, " ")}</span>
          <span>{Number.isInteger(e.value) ? e.value : e.value.toFixed(1)}</span>
          <span className="r" />
        </>
      );
    case "lifecycle":
      return (
        <>
          <span className="k">lifecycle</span>
          <span className="what">{e.kind}</span>
          <span className="faint">{e.release}</span>
          <span className="r" />
        </>
      );
    case "block":
      return (
        <>
          <span className="k">blocked</span>
          <span className="what">{e.route ?? "no request in flight"}</span>
          <span>
            {e.count}× · max {dur(e.max_ms)}
          </span>
          <span className="r">{dur(e.total_ms)}</span>
        </>
      );
  }
}

export function LiveFeed({ app }: { app: string }) {
  const [conn, setConn] = useState<Conn>("connecting");
  const [rows, setRows] = useState<Row[]>([]);
  const [gaps, setGaps] = useState(0);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(0);
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({ request: true, outbound: true, error: true, lifecycle: true, block: true, metric: false });
  const [bots, setBots] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const seconds = useRef<Second[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const stop = new AbortController();
    let seq = 0;
    let retry = 5000;
    let backoff = retry;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const count = (events: LiveEvent[]) => {
      const s = Math.floor(Date.now() / 1000);
      let cur = seconds.current[seconds.current.length - 1];
      if (!cur || cur.s !== s) seconds.current.push((cur = { s, requests: 0, errors: 0, failed: 0 }));
      for (const e of events) {
        if (e.type === "request" && !isBot(e)) {
          cur.requests++;
          if (e.status >= 500) cur.errors++;
        } else if (failedCall(e)) cur.failed++;
      }
      seconds.current = seconds.current.filter((x) => x.s > s - 60);
    };

    const onMessage = (event: string, data: string) => {
      if (event === "gap") {
        const d = JSON.parse(data) as { dropped: number };
        setGaps((g) => g + d.dropped);
        return;
      }
      if (event !== "events") return;
      const { events } = JSON.parse(data) as { events: LiveEvent[] };
      count(events);
      if (pausedRef.current) {
        setHeld((h) => h + events.length);
        return;
      }
      setRows((prev) => {
        const add = events.map((e) => ({ n: ++seq, e })).reverse();
        return [...add, ...prev].slice(0, RING);
      });
    };

    const connect = async () => {
      try {
        const res = await fetch(`/api/live/${encodeURIComponent(app)}`, { cache: "no-store", signal: stop.signal });
        if (res.status === 401) return setConn("signed-out");
        if (res.status === 503) return setConn("off");
        if (res.status === 404) return setConn("gone");
        if (res.status === 429) {
          setConn("busy");
          backoff = 60_000;
          throw new Error("busy");
        }
        if (!res.ok || !res.body) throw new Error("unavailable");
        setConn("live");
        backoff = retry;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf = parse(buf + value, onMessage, (ms) => (retry = backoff = ms));
        }
        if (!stop.signal.aborted) setConn("reconnecting");
      } catch {
        if (stop.signal.aborted) return;
        setConn((c) => (c === "busy" ? c : "reconnecting"));
      }
      if (stop.signal.aborted) return;
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
    void connect();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop.abort();
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [app]);

  const lastMinute = seconds.current.filter((x) => x.s > Math.floor(now / 1000) - 60);
  const sum = (k: "requests" | "errors" | "failed") => lastMinute.reduce((t, x) => t + x[k], 0);
  const shown = rows.filter((r) => kinds[r.e.type] && (bots || !isBot(r.e))).slice(0, SHOWN);
  const stopped = conn === "signed-out" || conn === "off" || conn === "gone";

  return (
    <>
      <section className="first">
        <div className="livebar">
          <span className={`conn ${conn}`} role="status">
            <i aria-hidden="true" />
            {CONN_TEXT[conn]}
            {conn === "signed-out" ? (
              <>
                {" "}
                <a href="/login">Sign in again</a>
              </>
            ) : null}
            {conn === "off" ? <span className="muted"> Set ABIGAAIL_LIVE_TOKEN for both the server and the dashboard.</span> : null}
          </span>
        </div>
        <div className="figures livefigs">
          <div className="figure">
            <div className="label">Requests, last minute</div>
            <div className="value">{sum("requests")}</div>
          </div>
          <div className="figure">
            <div className="label">Server errors, last minute</div>
            <div className={`value${sum("errors") ? " bad" : ""}`}>{sum("errors")}</div>
          </div>
          <div className="figure">
            <div className="label">Failed outbound calls, last minute</div>
            <div className={`value${sum("failed") ? " bad" : ""}`}>{sum("failed")}</div>
          </div>
        </div>
        <p className="small faint">Counted as they arrive, not judged; Health judges against the usual. Bots and probes are not counted.</p>
      </section>

      <section>
        <div className="livecontrols">
          {(["request", "outbound", "error", "lifecycle", "block", "metric"] as const).map((k) => (
            <label key={k}>
              <input type="checkbox" checked={kinds[k]} onChange={(ev) => setKinds({ ...kinds, [k]: ev.target.checked })} />
              {KIND_TEXT[k]}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={bots} onChange={(ev) => setBots(ev.target.checked)} />
            Bots and probes
          </label>
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            disabled={stopped}
            onClick={() => {
              if (paused) setHeld(0);
              setPaused(!paused);
            }}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
        {paused ? <p className="small muted">Paused. {held} event{held === 1 ? "" : "s"} arrived since (not shown).</p> : null}
        {gaps ? <p className="small muted">{gaps} event{gaps === 1 ? "" : "s"} skipped to keep up.</p> : null}
        {shown.length ? (
          <ol className="feed" aria-live="off">
            {shown.map(({ n, e }) => (
              <li key={n} className={isBot(e) ? "botrow" : undefined}>
                <span className="t">{hms(e.ts)}</span>
                <Line e={e} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">{stopped ? "Not connected." : "Waiting for events. Times are UTC."}</p>
        )}
      </section>
    </>
  );
}
