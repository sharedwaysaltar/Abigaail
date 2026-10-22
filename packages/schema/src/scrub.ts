// The allowlist scrubber (DECISIONS #101-#105): the only way free text may
// leave a monitored app. Shared by the SDK (before an event is queued) and the
// server (before it is stored), so both apply the same rules, versioned by
// SCRUB_VERSION.
//
// It is an allowlist tokenizer, not a list of redaction patterns: a token is
// kept only if it is a vocabulary word, an identifier made only of
// vocabulary words, an error code, a small number, punctuation, or one of the
// app's own outbound hosts. Anything recognisably sensitive becomes a typed
// placeholder (<email>, <ip>, ...); anything else unclassified becomes <word>
// (or <value> inside quotes). It fails closed: too little left, too much
// replaced, or any exception, and there is no message at all.
//
// Cost is bounded: the input is cut to SCRUB_LIMITS.inputMax before anything
// else, the text is walked once, and every pattern is anchored, has no nested
// quantifiers and runs on a token of at most SCRUB_LIMITS.tokenMax characters.

import { HOST_RE, isIp as isIpGuard } from "./index.js";

/** Not a type guard: a string that is not an IP is still a string. */
const isIp = (s: string): boolean => isIpGuard(s);
import { NAME_LIKE, VOCABULARY } from "./scrub-vocab.js";

/** A path segment the route heuristic may keep: an identifier of vocabulary words, never a name-like one (DECISIONS #108). */
export function isRouteWord(segment: string): boolean {
  // One letter names nobody ("/u/[id]").
  if (/^[a-z]$/.test(segment)) return true;
  return isVocabIdentifier(segment) && !identifierPieces(segment).some((p) => NAME_LIKE.has(p.toLowerCase()));
}

/** Rules and vocabulary version. Any change to either bumps it. */
export const SCRUB_VERSION = 2;
/** 1: chunk 9. 2: a number keeps only a fixed, case-exact unit ("221B" is no longer "221 bytes"). */
export const SCRUB_VERSIONS: readonly number[] = [1, 2];

export const SCRUB_LIMITS = {
  /** Characters looked at; the rest is cut before any work. */
  inputMax: 1024,
  /** Characters sent or stored. */
  outputMax: 200,
  /** Longer tokens are <token>. */
  tokenMax: 128,
  /** A message needs at least this many kept words... */
  minWords: 2,
  /** ...and no more than this share of placeholders. */
  maxPlaceholderShare: 0.5,
} as const;

export const PLACEHOLDERS = [
  "email", "ip", "url", "host", "jwt", "key", "card", "iban", "phone", "uuid", "id", "token", "path", "object", "value", "word",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface ScrubOptions {
  /** Hostnames kept as they are: the app's own outbound hosts. Any other hostname is <host>. */
  knownHost?: (host: string) => boolean;
}

// ---- codes --------------------------------------------------------------------

/** Node and libuv error codes (errno names), the ones libraries put in `code`. */
const ERRNO = new Set(
  ("EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EAI_AGAIN EAI_FAIL EAI_NONAME EALREADY EBADF EBUSY ECANCELED ECHILD " +
    "ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK EDESTADDRREQ EEXIST EFAULT EFBIG EHOSTDOWN EHOSTUNREACH EINTR EINVAL EIO " +
    "EISCONN EISDIR ELOOP EMFILE EMLINK EMSGSIZE ENAMETOOLONG ENETDOWN ENETRESET ENETUNREACH ENFILE ENOBUFS ENODATA ENODEV " +
    "ENOENT ENOMEM ENOSPC ENOSYS ENOTCONN ENOTDIR ENOTEMPTY ENOTFOUND ENOTSOCK ENOTSUP EPERM EPIPE EPROTO ERANGE EROFS " +
    "ESHUTDOWN ESPIPE ESRCH ETIMEDOUT ETXTBSY EXDEV ECONNECTION EAUTH ETLS ESOCKET EENVELOPE EMESSAGE ESTREAM").split(" "),
);

const PRISMA_CODE_RE = /^P\d{4}$/;
/** SQLSTATE (pg): five characters, at least two of them digits ("23505", "42P01"). */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/** Split an identifier at "_", ".", "/", "-", "@", "$", ":" and camelCase and letter/digit boundaries. */
export function identifierPieces(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if ("_./-@$:".includes(c)) {
      flush();
      continue;
    }
    const prev = s[i - 1] ?? "";
    const next = s[i + 1] ?? "";
    const upper = c >= "A" && c <= "Z";
    const digit = c >= "0" && c <= "9";
    const prevLower = prev >= "a" && prev <= "z";
    const prevUpper = prev >= "A" && prev <= "Z";
    const prevDigit = prev >= "0" && prev <= "9";
    const nextLower = next >= "a" && next <= "z";
    // findUnique -> find|Unique; HTTPServer -> HTTP|Server; utf8 -> utf|8.
    if (cur && ((upper && (prevLower || prevDigit)) || (upper && prevUpper && nextLower) || (digit !== prevDigit && (digit || prevDigit)))) flush();
    cur += c;
  }
  flush();
  return out;
}

/**
 * Every piece is a vocabulary word: an identifier made of known words only.
 * A token mixing letters and digits is kept only if it is itself a
 * vocabulary word ("utf8", "v1"), so "12a", "221B" or "email_1" are not;
 * `digits` allows number pieces of at most 5 digits (error codes: ERR_HTTP2_...).
 */
export function isVocabIdentifier(s: string, digits = false): boolean {
  if (!s || s.length > SCRUB_LIMITS.tokenMax || !/^[A-Za-z0-9_./\-@$:]+$/.test(s) || !/[A-Za-z]/.test(s)) return false;
  if (VOCABULARY.has(s.toLowerCase())) return true;
  if (!digits && /\d/.test(s)) return false;
  const pieces = identifierPieces(s);
  return pieces.length > 0 && pieces.every((p) => (/^\d+$/.test(p) ? p.length <= 5 : VOCABULARY.has(p.toLowerCase())));
}

/**
 * An error code that may be sent as it is: an errno name, a Prisma code, a
 * SQLSTATE, or an identifier made only of vocabulary words (ERR_INVALID_ARG_TYPE,
 * UND_ERR_CONNECT_TIMEOUT, ER_DUP_ENTRY, card_declined). Anything else: undefined.
 */
export function cleanCode(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e6) return String(v);
  if (typeof v !== "string" || v.length < 2 || v.length > 40) return undefined;
  if (ERRNO.has(v) || PRISMA_CODE_RE.test(v)) return v;
  if (SQLSTATE_RE.test(v) && v.replace(/[^0-9]/g, "").length >= 2) return v;
  if (/^[A-Za-z][A-Za-z0-9_.]*$/.test(v)) {
    const rest = v.replace(/^(UND_ERR_|ERR_|ER_)/, "");
    if (rest && isVocabIdentifier(rest, true)) return v;
  }
  return undefined;
}

// ---- detectors ----------------------------------------------------------------

const JWT_RE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;
const KEY_PREFIXES = [
  "sk_live_", "sk_test_", "rk_live_", "rk_test_", "pk_live_", "pk_test_", "whsec_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
  "xoxa-", "xoxb-", "xoxp-", "xoxo-", "xoxr-", "xoxs-", "AKIA", "ASIA", "AIza", "abk_", "glpat-", "npm_", "SG.", "sk-",
];
const SECRET_NAMES = new Set([
  "password", "passwd", "pwd", "pass", "secret", "token", "apikey", "api_key", "key", "access_token", "refresh_token", "id_token",
  "auth", "authorization", "session", "sessionid", "cookie", "sig", "signature", "client_secret", "private_key",
]);
const EMAIL_RE = /^(?:mailto:)?[^\s@<>()]{1,64}@[^\s@<>()]{1,255}$/i;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const URL_START_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\//;
/**
 * A number with at most a known unit, case exact: a token mixing digits and
 * letters is otherwise never kept ("221B", "4th", "2FA" are <word>).
 */
const NUMBER_RE = /^\d{1,5}(?:\.\d{1,3})?(?:ms|s|m|h|d|KB|MB|GB|TB|KiB|MiB|GiB|kB|%)?$/;
const LONG_DIGITS_RE = /^\d{6,}$/;
const HEX_ID_RE = /^(?:0x)?[0-9a-fA-F]{12,}$/;
const PREFIXED_ID_RE = /^[A-Za-z]{2,10}_[A-Za-z0-9]{3,}$/;
const TOKENISH_RE = /^[A-Za-z0-9+/_-]{20,}={0,2}$/;
const PLACEHOLDER_RE = /^<(?:email|ip|url|host|jwt|key|card|iban|phone|uuid|id|token|path|object|value|word)>|^<url [a-z0-9.-]{1,253}>/;

/** Last labels that make a dotted token a hostname rather than an identifier or a file name. */
const TLDS = new Set(
  ("com net org io co dev app ai me info biz us uk de fr nl eu ca au jp cn ru br in es it ch se no fi dk pl cz be at ie nz za mx " +
    "edu gov mil int cloud site online store tech xyz example test local internal localhost lan home arpa corp shop blog page " +
    "live news link click top win club pro").split(" "),
);

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(s: string): boolean {
  if (s.length < 15 || s.length > 34) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let mod = 0;
  for (let i = 0; i < r.length; i++) {
    const c = r.charCodeAt(i);
    const v = c >= 65 ? c - 55 : c - 48;
    mod = v > 9 ? (mod * 100 + v) % 97 : (mod * 10 + v) % 97;
  }
  return mod === 1;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isAlnum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);
const isUpper = (c: string | undefined) => c !== undefined && c >= "A" && c <= "Z";

interface Span {
  start: number;
  end: number;
  placeholder: Placeholder;
}

/**
 * Multi-word values found before tokenizing, in one pass each: card numbers
 * (Luhn), IBANs (mod 97) and phone numbers, which span spaces and dashes.
 */
function findSpans(s: string): Span[] {
  const spans: Span[] = [];
  // URLs are read whole (scheme to the next space), so no span starts inside one.
  const inUrl = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    if (!URL_START_RE.test(s.slice(i, i + 20)) || (i > 0 && !" \t\"'`<>(".includes(s[i - 1]!))) continue;
    let j = i;
    while (j < s.length && !" \t\"'`<>".includes(s[j]!)) inUrl[j++] = 1;
    i = j;
  }
  // IBAN: two letters, two digits, then letters/digits with single spaces, 15-34 in all.
  for (let i = 0; i + 4 <= s.length; i++) {
    if (inUrl[i] || isAlnum(s[i - 1]) || !isUpper(s[i]) || !isUpper(s[i + 1]) || !isDigit(s[i + 2]) || !isDigit(s[i + 3])) continue;
    let compact = "";
    const ends: number[] = [];
    let j = i;
    while (j < s.length && compact.length < 34) {
      const c = s[j]!;
      if (isAlnum(c)) {
        compact += c.toUpperCase();
        ends.push(j + 1);
        j++;
      } else if (c === " " && isAlnum(s[j + 1]) && compact.length >= 4) j++;
      else break;
    }
    for (let len = compact.length; len >= 15; len--) {
      if (isAlnum(s[ends[len - 1]!])) continue;
      if (ibanValid(compact.slice(0, len))) {
        spans.push({ start: i, end: ends[len - 1]!, placeholder: "iban" });
        i = ends[len - 1]! - 1;
        break;
      }
    }
  }
  // Cards and phones: digits with single separators (space, "-", ".", "(", ")", "/"), optional leading "+".
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inUrl[i] || !(isDigit(c) || ((c === "+" || c === "(") && isDigit(s[i + 1])))) continue;
    if (/[A-Za-z0-9_]/.test(s[i - 1] ?? " ")) {
      while (i < s.length && /[A-Za-z0-9_]/.test(s[i]!)) i++;
      continue;
    }
    if (spans.some((sp) => i >= sp.start && i < sp.end)) continue;
    let j = i;
    let digits = "";
    let seps = 0;
    let lastDigit = i;
    let sepRun = 0;
    while (j < s.length) {
      const d = s[j]!;
      if (isDigit(d)) {
        digits += d;
        lastDigit = j;
        sepRun = 0;
      } else if (" -.()/+".includes(d) && sepRun < 2 && (j === i || isDigit(s[j + 1]) || (d === ")" && s[j + 1] === " " && isDigit(s[j + 2])))) {
        if (j !== i) seps++;
        sepRun++;
      } else break;
      j++;
    }
    const end = lastDigit + 1;
    if (/[A-Za-z]/.test(s[end] ?? " ")) {
      i = end;
      continue;
    }
    const text = s.slice(i, end);
    // An IPv4 address is read as one later (with its port).
    const dotted = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text);
    // Fail closed: no run of 7 or more digits is ever kept, whatever it is.
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) spans.push({ start: i, end, placeholder: "card" });
    else if (dotted) {
      // Left for the IP rule.
    } else if (digits.length >= 7 && digits.length <= 15 && (text.startsWith("+") || text.startsWith("(") || seps >= 1)) {
      spans.push({ start: i, end, placeholder: "phone" });
    } else if (digits.length >= 7) spans.push({ start: i, end, placeholder: "id" });
    i = end;
  }
  return spans.sort((a, b) => a.start - b.start);
}

// ---- tokens -------------------------------------------------------------------

const BREAK = " \t()[]{},;!?\"'`<>";
const QUOTES = "'\"`";
const OPENS_QUOTE_AFTER = " \t([{=:,@.";

interface Ctx {
  opts: ScrubOptions;
  out: string[];
  words: number;
  placeholders: number;
  prevWord: string;
}

function placeholder(ctx: Ctx, p: Placeholder | string): string {
  ctx.placeholders++;
  return p.startsWith("<") ? p : `<${p}>`;
}

function hostKept(ctx: Ctx, host: string): boolean {
  try {
    return !!ctx.opts.knownHost?.(host.toLowerCase());
  } catch {
    return false;
  }
}

function hostShaped(s: string): boolean {
  if (!s.includes(".") || s.length > 253 || !HOST_RE.test(s)) return false;
  const last = s.slice(s.lastIndexOf(".") + 1).toLowerCase();
  return TLDS.has(last);
}

/** scheme://user:pass@host:port/path?query#frag -> <url host> for a known host, else <url>. */
function urlToken(ctx: Ctx, s: string): string {
  const rest = s.slice(s.indexOf("://") + 3);
  let authority = rest;
  for (const sep of ["/", "?", "#"]) {
    const k = authority.indexOf(sep);
    if (k >= 0) authority = authority.slice(0, k);
  }
  const at = authority.lastIndexOf("@");
  let host = at >= 0 ? authority.slice(at + 1) : authority;
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]") >= 0 ? host.indexOf("]") : host.length);
  else if (host.lastIndexOf(":") > 0) host = host.slice(0, host.lastIndexOf(":"));
  if (HOST_RE.test(host) && !isIp(host) && hostKept(ctx, host)) return placeholder(ctx, `<url ${host.toLowerCase()}>`);
  return placeholder(ctx, "url");
}

/** A typed placeholder for a value found inside percent-encoding, or undefined. */
function typed(ctx: Ctx, s: string): string | undefined {
  if (JWT_RE.test(s)) return placeholder(ctx, "jwt");
  if (KEY_PREFIXES.some((p) => s.startsWith(p) && s.length > p.length + 3)) return placeholder(ctx, "key");
  if (URL_START_RE.test(s)) return urlToken(ctx, s);
  if (s.includes("@") && EMAIL_RE.test(s) && s.slice(s.lastIndexOf("@") + 1).includes(".")) return placeholder(ctx, "email");
  if (UUID_RE.test(s)) return placeholder(ctx, "uuid");
  return undefined;
}

/** Classify one token (no spaces or break characters). Returns what is sent in its place. */
function token(ctx: Ctx, raw: string, depth = 0): string {
  const s = raw;
  if (!s) return s;
  // Fast path: a plain lowercase vocabulary word (most tokens).
  if (s.length <= 24 && /^[a-z]+$/.test(s) && VOCABULARY.has(s) && !/^(bearer|basic)$/i.test(ctx.prevWord)) {
    ctx.words++;
    return s;
  }
  if (s.length > SCRUB_LIMITS.tokenMax || depth > 2) return placeholder(ctx, "token");
  if (PLACEHOLDER_RE.test(s) && (s.match(PLACEHOLDER_RE)![0] === s)) {
    if (s.startsWith("<url ")) return hostKept(ctx, s.slice(5, -1)) ? placeholder(ctx, s) : placeholder(ctx, "url");
    return placeholder(ctx, s);
  }
  if (/^[.:\-/=+*&|~^#]+$/.test(s)) return s;
  if (/[^\x21-\x7e]/.test(s)) return placeholder(ctx, "word");

  // Percent-encoding is never sent: a typed value inside it, or <token>.
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      return placeholder(ctx, "token");
    }
    return typed(ctx, decoded.trim()) ?? placeholder(ctx, "token");
  }
  if (/^(bearer|basic)$/i.test(ctx.prevWord) && depth === 0) return placeholder(ctx, "key");

  const t = typed(ctx, s);
  if (t) return t;
  if (s.includes("@")) return s.split("@").map((p) => (p ? token(ctx, p, depth + 1) : p)).join("@");

  // Base64 with padding, before it is read as name=value.
  if (s.length >= 16 && s.length % 4 === 0 && /^[A-Za-z0-9+/_-]{14,}={1,2}$/.test(s)) return placeholder(ctx, "token");
  const eq = s.indexOf("=");
  if (eq > 0) {
    const name = s.slice(0, eq);
    const value = s.slice(eq + 1);
    const left = token(ctx, name, depth + 1);
    if (!value) return `${left}=`;
    return `${left}=${SECRET_NAMES.has(name.toLowerCase()) ? placeholder(ctx, "key") : token(ctx, value, depth + 1)}`;
  }

  // An IP, alone or with a port; IPv4-mapped IPv6 too.
  const bare = s.replace(/^::ffff:/i, "");
  if (isIp(s) || isIp(bare)) return placeholder(ctx, "ip");
  const colon = s.lastIndexOf(":");
  if (colon > 0 && /^\d{1,5}$/.test(s.slice(colon + 1)) && (isIp(s.slice(0, colon)) || isIp(s.slice(0, colon).replace(/^::ffff:/i, "")))) {
    return `${placeholder(ctx, "ip")}:${s.slice(colon + 1)}`;
  }

  if (NUMBER_RE.test(s)) return s;
  if (LONG_DIGITS_RE.test(s)) return placeholder(ctx, "id");
  if (HEX_ID_RE.test(s) && /\d/.test(s)) return placeholder(ctx, "id");
  if (cleanCode(s) === s && !isVocabIdentifier(s)) return s;

  // Absolute paths carry user names; relative ones are identifiers below.
  if (s.startsWith("/") || s.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(s) || s.includes("\\")) return placeholder(ctx, "path");

  if (hostShaped(s)) return hostKept(ctx, s) ? s : placeholder(ctx, "host");

  if (s.includes(":") && depth === 0 && !isVocabIdentifier(s)) {
    return s.split(":").map((p) => (p ? token(ctx, p, depth + 1) : p)).join(":");
  }

  if (isVocabIdentifier(s)) {
    // A capitalised vocabulary word that is also a first name may be a name ("Mark", "Will"), even first in a sentence.
    if (nameLike(s) || (/^[A-Z]+$/.test(s) && NAME_LIKE.has(s.toLowerCase()))) return placeholder(ctx, "word");
    ctx.words++;
    return s;
  }
  if (PREFIXED_ID_RE.test(s) && /[0-9]|[A-Z]/.test(s.slice(s.indexOf("_") + 1))) return placeholder(ctx, "id");
  if (TOKENISH_RE.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return placeholder(ctx, "token");
  return placeholder(ctx, "word");
}

/** A capitalised piece that is also a first name ("Grant", "Will"): never kept, quoted or not. */
const nameLike = (s: string) => identifierPieces(s).some((p) => /^[A-Z]/.test(p) && NAME_LIKE.has(p.toLowerCase()));

/** The contents of a quoted span: kept only if it is one identifier of vocabulary words, a code or a known host. */
function quoted(ctx: Ctx, content: string): string {
  if (content === "") return content;
  if (nameLike(content)) return placeholder(ctx, "value");
  if (PLACEHOLDER_RE.test(content) && content.match(PLACEHOLDER_RE)![0] === content) return token(ctx, content);
  const call = content.endsWith("()") ? content.slice(0, -2) : content;
  if (!/\s/.test(call)) {
    if (isVocabIdentifier(call) && !hostShaped(call)) {
      ctx.words++;
      return content;
    }
    if (hostShaped(call) && hostKept(ctx, call)) return content;
    if (cleanCode(call) === call && !/^\d+$/.test(call)) return content;
  }
  return placeholder(ctx, "value");
}

function stripInvisible(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // Lone surrogates make the whole text unusable (fail closed).
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("lone surrogate");
      out += s[i]! + s[i + 1]!;
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new Error("lone surrogate");
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      out += " ";
      continue;
    }
    // Format characters: zero-width, bidi controls, BOM, soft hyphen.
    if (code === 0xad || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff) {
      continue;
    }
    out += s[i]!;
  }
  return out;
}

function run(input: string, opts: ScrubOptions): string | undefined {
  let s = input.slice(0, SCRUB_LIMITS.inputMax);
  // A pair cut in half by the slice.
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  const nl = s.search(/[\r\n]/);
  if (nl >= 0) s = s.slice(0, nl);
  s = stripInvisible(s.normalize("NFKC")).slice(0, SCRUB_LIMITS.inputMax);

  const spans = findSpans(s);
  const ctx: Ctx = { opts, out: [], words: 0, placeholders: 0, prevWord: "" };
  let span = 0;
  let i = 0;
  // A hard bound on the work: every step consumes at least one character.
  let steps = 0;
  const push = (piece: string, word?: string) => {
    ctx.out.push(piece);
    if (word !== undefined) ctx.prevWord = word;
  };
  while (i < s.length) {
    if (++steps > s.length + 8) throw new Error("no progress");
    // A span the previous token ran into (a URL reads to the next space) is dropped, never half-used.
    while (span < spans.length && spans[span]!.start < i) span++;
    const sp = spans[span];
    if (sp && sp.start === i) {
      push(placeholder(ctx, sp.placeholder), "");
      i = sp.end;
      continue;
    }
    const c = s[i]!;
    if (c === " " || c === "\t") {
      if (ctx.out.length && ctx.out[ctx.out.length - 1] !== " ") ctx.out.push(" ");
      i++;
      continue;
    }
    if (c === "<") {
      const m = PLACEHOLDER_RE.exec(s.slice(i, i + 260));
      if (m) {
        push(token(ctx, m[0]), "");
        i += m[0].length;
        continue;
      }
      push("<");
      i++;
      continue;
    }
    if (QUOTES.includes(c) && (i === 0 || OPENS_QUOTE_AFTER.includes(s[i - 1]!))) {
      const close = s.indexOf(c, i + 1);
      if (close > i && close - i - 1 <= SCRUB_LIMITS.tokenMax) {
        push(`${c}${quoted(ctx, s.slice(i + 1, close))}${c}`, "");
        i = close + 1;
        continue;
      }
      if (close > i) {
        push(`${c}${placeholder(ctx, "value")}${c}`, "");
        i = close + 1;
        continue;
      }
    }
    if (c === "{" || c === "[") {
      // A JSON-like blob: everything to the matching close (or the end) is <object>.
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        const d = s[j]!;
        if (d === "{" || d === "[") depth++;
        else if (d === "}" || d === "]") {
          depth--;
          if (depth === 0) break;
        }
      }
      // "[object Object]" and empty brackets read the same.
      push(placeholder(ctx, "object"), "");
      i = j + 1;
      continue;
    }
    if (BREAK.includes(c)) {
      push(c, ctx.prevWord);
      i++;
      continue;
    }
    // A token: up to whitespace, a break character, or the next span. A URL runs to the next space.
    let j = i;
    const stop = sp ? sp.start : s.length;
    if (URL_START_RE.test(s.slice(i, i + 20))) {
      while (j < s.length && !" \t\"'`<>".includes(s[j]!)) j++;
    }
    while (j < stop) {
      const d = s[j]!;
      if (d === "'" && /[A-Za-z]/.test(s[j - 1] ?? "") && /[A-Za-z]/.test(s[j + 1] ?? "")) {
        j++;
        continue;
      }
      if (BREAK.includes(d)) break;
      j++;
    }
    if (j === i) j = i + 1;
    let raw = s.slice(i, j);
    // Sentence punctuation at the end is kept as punctuation, not part of the token.
    let tail = "";
    while (raw.length > 1 && /[.:,]$/.test(raw) && !/\.\.\.$/.test(raw)) {
      tail = raw.slice(-1) + tail;
      raw = raw.slice(0, -1);
    }
    const lower = raw.toLowerCase();
    const isApostropheWord = raw.includes("'");
    const piece = isApostropheWord ? (VOCABULARY.has(lower) ? (ctx.words++, raw) : placeholder(ctx, "word")) : token(ctx, raw);
    push(piece, raw);
    if (tail) push(tail, raw + tail);
    i = j;
  }

  // Cut to the output limit at a piece boundary.
  let out = "";
  for (const piece of ctx.out) {
    if (out.length + piece.length > SCRUB_LIMITS.outputMax - 3) {
      out = `${out.trimEnd()}...`;
      break;
    }
    out += piece;
  }
  out = out.trim();
  if (ctx.words < SCRUB_LIMITS.minWords) return undefined;
  if (ctx.placeholders > SCRUB_LIMITS.maxPlaceholderShare * (ctx.words + ctx.placeholders)) return undefined;
  return out || undefined;
}

/**
 * Scrub free text (an error message) for sending or storing. Returns the
 * scrubbed text, or undefined when nothing safe and useful is left. Never
 * throws; the result is a fixed point (scrub(scrub(x)) === scrub(x)).
 */
export function scrub(input: unknown, opts: ScrubOptions = {}): string | undefined {
  if (typeof input !== "string" || !input) return undefined;
  try {
    const once = run(input, opts);
    if (once === undefined) return undefined;
    // Fail closed: if a second pass would change it, something was misread; send nothing.
    const twice = run(once, opts);
    return twice === once ? once : undefined;
  } catch {
    return undefined;
  }
}

/** Already scrubbed by these rules: scrubbing it again changes nothing. */
export function isScrubbed(s: unknown, opts: ScrubOptions = {}): boolean {
  return typeof s === "string" && scrub(s, opts) === s;
}
