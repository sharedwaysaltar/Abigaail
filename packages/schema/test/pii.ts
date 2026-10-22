// Seeded generators of realistic personal data for the privacy tests
// (DECISIONS #106). No dependency: a small PRNG, so a failing case is
// reproduced by its seed. Each value comes with the needles that must never
// appear in anything that leaves the app or reaches the store.

export type Rng = () => number;

/** mulberry32. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const digits = (r: Rng, n: number) => Array.from({ length: n }, () => String(int(r, 0, 9))).join("");
const base62 = (r: Rng, n: number) => Array.from({ length: n }, () => pick(r, [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"])).join("");

export const FIRST_NAMES = [
  "Jane", "John", "Maria", "Ahmed", "Olivia", "Liam", "Noah", "Emma", "Sofia", "Lucas", "Mia", "Arjun", "Priya", "Chen", "Wei", "Yuki",
  "Fatima", "Omar", "Elena", "Mateo", "Zoë", "Søren", "Björn", "Chloé", "José", "Łukasz", "Ağca", "Nguyễn", "Siobhán", "Hannah",
  "Ethan", "Isabella", "Amelia", "Oliver", "Charlotte", "Benjamin", "Harper", "Jacob", "Evelyn", "Daniel", "Abigail", "Logan",
  "Emily", "Samuel", "Ella", "Henry", "Avery", "Jackson", "Scarlett", "Sebastian", "Aria", "Aiden", "Luna", "Matthew", "Layla",
  "Mark", "Will", "Grace", "Rose", "Max", "May", "Grant", "Chase", "Hope", "Joy", "Ray", "Pat", "Summer", "Art",
];
export const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Garcia", "Müller", "Schmidt", "Rossi", "Dubois", "Kowalski", "Nakamura", "Kim", "Singh",
  "Patel", "O'Brien", "van der Berg", "García-López", "Øvergaard", "Çelik", "Ivanova", "Haddad", "Okafor", "Silva", "Novák",
];
const DOMAINS = ["example.com", "mail.example.org", "corp.example.net", "example.co.uk", "uni.example.edu", "exämple.de"];

export interface Pii {
  kind: string;
  /** What is put into the text. */
  text: string;
  /** Substrings that must not appear in any output (case-insensitive unless kind is "name"). */
  needles: string[];
  /** Digits that must not appear, with separators removed (phones, cards, IBANs, long ids). */
  digits?: string;
}

function luhnDigit(partial: string): string {
  for (let d = 0; d <= 9; d++) {
    const s = partial + d;
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      let x = s.charCodeAt(s.length - 1 - i) - 48;
      if (i % 2 === 1) {
        x *= 2;
        if (x > 9) x -= 9;
      }
      sum += x;
    }
    if (sum % 10 === 0) return String(d);
  }
  return "0";
}

function ibanCheck(country: string, bban: string): string {
  const r = `${bban}${country}00`;
  let mod = 0;
  for (const c of r) {
    const v = c >= "A" ? c.charCodeAt(0) - 55 : c.charCodeAt(0) - 48;
    mod = v > 9 ? (mod * 100 + v) % 97 : (mod * 10 + v) % 97;
  }
  return String(98 - mod).padStart(2, "0");
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** One personal value of a random kind. */
export function pii(r: Rng): Pii {
  const first = pick(r, FIRST_NAMES);
  const last = pick(r, LAST_NAMES);
  switch (int(r, 0, 11)) {
    case 0: {
      const local = pick(r, [first.toLowerCase(), `${first}.${last}`.toLowerCase(), `${first[0]}${last}${digits(r, 2)}`.toLowerCase(), `${first.toLowerCase()}+shop`]);
      const email = `${local}@${pick(r, DOMAINS)}`.replace(/\s/g, "");
      const text = pick(r, [email, email.toUpperCase(), `mailto:${email}`, `<${email}>`]);
      return { kind: "email", text, needles: [email, local.replace(/\s/g, "")].filter((n) => n.length >= 4) };
    }
    case 1: {
      const text = pick(r, [`${first} ${last}`, first, `${last}, ${first}`]);
      return { kind: "name", text, needles: [first, ...last.split(/[\s-]/)].filter((n) => n.length >= 3) };
    }
    case 2: {
      const d = `${int(r, 2, 9)}${digits(r, 9)}`;
      const text = pick(r, [`+44 ${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`, `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `+1-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`, `+49 30 ${d.slice(0, 8)}`]);
      return { kind: "phone", text, needles: [], digits: text.replace(/\D/g, "").slice(-7) };
    }
    case 3: {
      const partial = `4${digits(r, 14)}`;
      const card = partial + luhnDigit(partial);
      const text = pick(r, [card, card.replace(/(\d{4})(?=\d)/g, "$1 "), card.replace(/(\d{4})(?=\d)/g, "$1-")]);
      return { kind: "card", text, needles: [], digits: card };
    }
    case 4: {
      const [country, len] = pick(r, [["GB", 18], ["DE", 18], ["NL", 14], ["FR", 23]] as const);
      const bban = country === "GB" || country === "NL" ? `${pick(r, ["WEST", "ABNA", "BARC"])}${digits(r, len - 4)}` : digits(r, len);
      const iban = `${country}${ibanCheck(country, bban)}${bban}`;
      const text = pick(r, [iban, iban.replace(/(.{4})(?=.)/g, "$1 ")]);
      return { kind: "iban", text, needles: [iban, bban], digits: bban.replace(/\D/g, "") };
    }
    case 5: {
      const v4 = `${int(r, 11, 223)}.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}`;
      const v6 = `2001:${base62(r, 0)}${int(r, 4096, 65535).toString(16)}:${int(r, 4096, 65535).toString(16)}::${int(r, 1, 65535).toString(16)}`;
      const ip = r() < 0.6 ? v4 : v6;
      const form = int(r, 0, 2);
      const text = form === 0 ? ip : form === 1 ? `${ip.includes(":") ? `[${ip}]` : ip}:${int(r, 1, 65535)}` : `::ffff:${v4}`;
      return { kind: "ip", text, needles: [form === 2 ? v4 : ip] };
    }
    case 6: {
      const jwt = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: digits(r, 8), email: `${first.toLowerCase()}@example.com` }))}.${base62(r, 43)}`;
      return { kind: "jwt", text: jwt, needles: [jwt, jwt.split(".")[1]!.slice(0, 16)] };
    }
    case 7: {
      const secret = base62(r, 24);
      const key = `${pick(r, ["sk_live_", "sk_test_", "ghp_", "xoxb-", "AKIA", "AIza", "abk_", "github_pat_", "whsec_"])}${secret}`;
      const text = pick(r, [key, `Bearer ${secret}`, `password=${secret}`, `token=${secret}`]);
      return { kind: "key", text, needles: [secret.slice(-16)] };
    }
    case 8: {
      const u = `${digits(r, 8)}-${digits(r, 4)}-4${digits(r, 3)}-a${digits(r, 3)}-${digits(r, 12)}`;
      const id = pick(r, [u, digits(r, 9), base62(r, 0) + Array.from({ length: 32 }, () => pick(r, [..."0123456789abcdef"])).join(""), `cus_${base62(r, 14)}`]);
      return { kind: "id", text: id, needles: [id], ...(/^\d+$/.test(id) ? { digits: id } : {}) };
    }
    case 9: {
      const email = `${first.toLowerCase()}@example.com`;
      const secret = base62(r, 12);
      const url = `https://${first.toLowerCase()}:${secret}@shop.example.com/users/${first.toLowerCase()}?email=${encodeURIComponent(email)}&token=${secret}`;
      return { kind: "url", text: url, needles: [email, secret, `${first.toLowerCase()}:`, `users/${first.toLowerCase()}`, "email="] };
    }
    case 10: {
      const email = `${first.toLowerCase()}.${last.toLowerCase().replace(/\W/g, "")}@example.com`;
      const json = JSON.stringify({ email, name: `${first} ${last}`, id: int(r, 1000, 99999) });
      return { kind: "json", text: json, needles: [email, first].filter((n) => n.length >= 3) };
    }
    default: {
      const handle = `${first.toLowerCase()}${pick(r, ["", "_", "."])}${last.toLowerCase().replace(/\W/g, "")}${pick(r, ["", digits(r, 2)])}`;
      return { kind: "handle", text: handle, needles: [handle].filter((n) => n.length >= 5) };
    }
  }
}

/** The same value in one of the encodings an app might hand over. */
export function encode(r: Rng, p: Pii): Pii {
  const t = p.text;
  switch (int(r, 0, 6)) {
    case 0:
      return { ...p, text: encodeURIComponent(t), needles: [...p.needles, encodeURIComponent(t)] };
    case 1: {
      const b = Buffer.from(t, "utf8").toString("base64");
      return { ...p, text: b, needles: [...p.needles, b.slice(0, 12)] };
    }
    case 2:
      return { ...p, text: t.toUpperCase() };
    case 3:
      // Fullwidth forms (NFKC folds them back).
      return { ...p, text: [...t].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("") };
    case 4:
      // Zero-width characters inside.
      return { ...p, text: [...t].map((c, i) => (i % 3 === 1 ? `​${c}` : c)).join("") };
    case 5:
      return { ...p, text: JSON.stringify({ value: t }) };
    default:
      return p;
  }
}

/** Every needle the output may not contain, and digit runs it may not hold. */
export function leaks(output: string, p: Pii): string[] {
  const found: string[] = [];
  const lower = output.toLowerCase();
  for (const n of p.needles) {
    if (p.kind === "name") {
      if (new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(output)) found.push(n);
    } else if (lower.includes(n.toLowerCase())) found.push(n);
  }
  if (p.digits && p.digits.length >= 7) {
    const collapsed = output.replace(/(\d)[\s\-.()/+]{0,2}(?=\d)/g, "$1");
    if (collapsed.includes(p.digits)) found.push(`digits ${p.digits}`);
  }
  return found;
}
