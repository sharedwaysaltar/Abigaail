// Where the server may send (DECISIONS #96): a webhook or heartbeat URL is
// https, or http only to this machine, and can never be pointed at internal
// services. Checked once when the config loads (the URL as written) and again
// at every connection (every address its name resolves to), so a name that
// later resolves to an internal address (DNS rebinding) is refused too.

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { isIPv4, isIPv6, type LookupFunction } from "node:net";

/**
 * public: anywhere on the internet. loopback: this machine. private: RFC 1918,
 * CGNAT (100.64/10, Tailscale) and IPv6 ULA (fc00::/7), allowed only with the
 * webhook's explicit opt-in. link_local (169.254/16 with cloud metadata,
 * fe80::/10) and special (unspecified, multicast, reserved, documentation,
 * benchmarking) are never allowed.
 */
export type AddressKind = "public" | "loopback" | "private" | "link_local" | "special";

export interface UrlPolicy {
  /** ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE=1 / ABIGAAIL_HEARTBEAT_ALLOW_PRIVATE=1: private, CGNAT and ULA addresses too. */
  allowPrivate?: boolean;
}

export class UrlRefused extends Error {
  override name = "UrlRefused";
  /** A fixed reason, never the URL. */
  constructor(readonly reason: string) {
    super(reason);
  }
}

function v4Kind(ip: string): AddressKind {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  if (a === 169 && b === 254) return "link_local";
  if (a === 0 || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))) return "special";
  return "public";
}

/** The 8 hextets of an IPv6 address (an embedded IPv4 tail is folded in). */
function hextets(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!isIPv4(tail[1]!)) return undefined;
    const [a, b, c, d] = tail[1]!.split(".").map(Number) as [number, number, number, number];
    s = s.slice(0, -tail[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const parts = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...rest];
  if (parts.length !== 8) return undefined;
  const out = parts.map((p) => parseInt(p, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : undefined;
}

export function addressKind(ip: string): AddressKind {
  if (isIPv4(ip)) return v4Kind(ip);
  if (!isIPv6(ip)) return "special";
  const h = hextets(ip);
  if (!h) return "special";
  const embedded = () => `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`;
  const zeroTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeroTo(7) && h[7] === 1) return "loopback";
  if (zeroTo(8)) return "special";
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) are judged by their IPv4 address.
  if (zeroTo(5) && h[5] === 0xffff) return v4Kind(embedded());
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4Kind(embedded());
  // IPv4-compatible (deprecated) and anything else under ::/96.
  if (zeroTo(6)) return "special";
  if ((h[0]! & 0xffc0) === 0xfe80) return "link_local";
  if ((h[0]! & 0xfe00) === 0xfc00) return "private";
  // Multicast, deprecated site-local, documentation.
  if ((h[0]! & 0xff00) === 0xff00 || (h[0]! & 0xffc0) === 0xfec0 || (h[0] === 0x2001 && h[1] === 0x0db8)) return "special";
  return "public";
}

/** The URL's host is this machine by name or address. */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || ((isIPv4(hostname) || isIPv6(hostname)) && addressKind(hostname) === "loopback");
}

/** Hostname without IPv6 brackets. */
export function bareHost(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/** May a connection for this URL go to this address? */
export function addressAllowed(ip: string, url: URL, policy: UrlPolicy = {}): boolean {
  const kind = addressKind(ip);
  // http (or https) to this machine must stay on this machine, whatever the name resolves to.
  if (isLocalHost(bareHost(url))) return kind === "loopback";
  if (kind === "public") return true;
  if (kind === "private") return !!policy.allowPrivate;
  return false;
}

/** Parse and check a URL the server will send to. Throws UrlRefused with a fixed reason, never the URL. */
export function checkUrl(raw: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRefused("not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UrlRefused("must be https (or http to localhost)");
  if (url.username || url.password) throw new UrlRefused("must not contain a user name or password");
  const host = bareHost(url);
  const local = isLocalHost(host);
  if (url.protocol === "http:" && !local) throw new UrlRefused("plain http is allowed only to localhost");
  if (isIPv4(host) || isIPv6(host)) {
    if (!addressAllowed(host, url, policy)) {
      const kind = addressKind(host);
      throw new UrlRefused(`${kind.replace("_", "-")} address`);
    }
  } else if (host !== "localhost" && host.endsWith(".localhost")) {
    throw new UrlRefused("*.localhost names are not allowed");
  }
  return url;
}

type Resolver = (hostname: string, options: LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `lookup` for http.request / https.request that resolves every address
 * and refuses the connection if any of them is not allowed for this URL.
 * The socket connects to the address that was checked.
 */
export function checkedLookup(url: URL, policy: UrlPolicy = {}, resolve: Resolver = dnsLookup): LookupFunction {
  return (hostname, options, cb) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      const done = cb as unknown as (e: Error | null, a?: string | LookupAddress[], f?: number) => void;
      if (err) return done(err);
      if (!addresses.length || addresses.some((a) => !addressAllowed(a.address, url, policy))) {
        return done(new UrlRefused("the name resolves to an address that is not allowed"));
      }
      if (options.all) return done(null, addresses);
      return done(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
