// The simulator only ever talks to demo apps on this machine. Every URL it
// sends a request to, and the ingest endpoint it gives a demo app, passes
// through here first; anything else is refused before a socket opens.

/** Hostnames accepted, exactly as WHATWG URL parsing normalises them. */
export const LOCAL_HOSTNAMES: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];

/** Parse and check a target: plain http, a loopback host, an explicit port, no credentials. */
export function assertLocalTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("refusing target: not a URL");
  }
  const refuse = (why: string) => new Error(`refusing ${url.host || "target"}: ${why}; the simulator only targets demo apps on this machine`);
  if (url.protocol !== "http:") throw refuse("only http:// is allowed");
  if (url.username || url.password) throw refuse("credentials in the URL are not allowed");
  if (!LOCAL_HOSTNAMES.includes(url.hostname)) throw refuse("not a loopback host");
  if (!url.port) throw refuse("an explicit port is required");
  return url;
}

/** The literal address to connect to (never resolved through DNS). */
export function connectAddress(url: URL): string {
  return url.hostname === "[::1]" ? "::1" : "127.0.0.1";
}
