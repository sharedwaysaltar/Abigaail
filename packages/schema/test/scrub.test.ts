// The allowlist scrubber (DECISIONS #101-#106): what it keeps, what it
// replaces, that it fails closed, never throws, and costs a bounded amount.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanCode, identifierPieces, isScrubbed, scrub, SCRUB_LIMITS } from "@abigaail/schema";
import { NAME_LIKE, VOCABULARY } from "../src/scrub-vocab.js";
import { CORPUS, KNOWN_HOSTS } from "./fixtures/error-corpus.js";
import { FIRST_NAMES } from "./pii.js";

const known = new Set(KNOWN_HOSTS);
const opts = { knownHost: (h: string) => known.has(h) };

describe("the corpus of real library errors", () => {
  it.each(CORPUS.map((c) => [`${c.lib}: ${c.input.slice(0, 70)}`, c] as const))("%s", (_label, c) => {
    expect(scrub(c.input, opts) ?? null).toBe(c.expected);
  });

  it("covers the libraries and keeps the useful ones useful", () => {
    expect(new Set(CORPUS.map((c) => c.lib))).toEqual(new Set(["pg", "mysql2", "prisma", "axios", "fetch", "stripe", "jwt", "node", "json", "type", "ioredis", "mongoose", "app"]));
    expect(CORPUS.length).toBeGreaterThanOrEqual(80);
    // Most library messages survive with their meaning; only a few are dropped as too little.
    expect(CORPUS.filter((c) => c.expected === null).length).toBeLessThan(5);
  });

  it("every expected output is a fixed point", () => {
    for (const c of CORPUS) if (c.expected !== null) expect(isScrubbed(c.expected, opts)).toBe(true);
  });
});

describe("identifiers: kept only when every piece is a vocabulary word", () => {
  it.each([
    ["user johnDoe not found", "user <word> not found"],
    ["could not find jane.smith in the list", "could not find <word> in the list"],
    ["Cannot read properties of undefined (reading 'jsmith')", "Cannot read properties of undefined (reading '<value>')"],
    ['duplicate key value violates unique constraint "users_email_key"', 'duplicate key value violates unique constraint "users_email_key"'],
    ["Duplicate entry 'x' for key 'users.email'", "Duplicate entry '<value>' for key 'users.email'"],
    ["Invalid `prisma.user.findUnique()` invocation:", "Invalid `prisma.user.findUnique()` invocation:"],
    ["Cannot read properties of null (reading 'length')", "Cannot read properties of null (reading 'length')"],
    ["column \"jane_notes\" does not exist", 'column "<value>" does not exist'],
    ["user.profile.getName is not a function", "user.profile.getName is not a function"],
    ["user.profile.getJaneName is not a function", "<word> is not a function"],
  ])("%s", (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it("splits at _, ., camelCase and letter/digit boundaries", () => {
    expect(identifierPieces("prisma.user.findUnique")).toEqual(["prisma", "user", "find", "Unique"]);
    expect(identifierPieces("users_email_key")).toEqual(["users", "email", "key"]);
    expect(identifierPieces("HTTPServer")).toEqual(["HTTP", "Server"]);
    expect(identifierPieces("utf8")).toEqual(["utf", "8"]);
    expect(identifierPieces("johnDoe")).toEqual(["john", "Doe"]);
  });

  it("no vocabulary word is a common first name, except the ones always treated as names", () => {
    const names = FIRST_NAMES.map((n) => n.toLowerCase()).filter((n) => VOCABULARY.has(n));
    expect(names.filter((n) => !NAME_LIKE.has(n))).toEqual([]);
    // Capitalised, they are names even first in a sentence.
    expect(scrub("Will Smith was not found in the list")).toBe("<word> <word> was not found in the list");
    expect(scrub("Hello from Mark and Grant about the order")).toBe("Hello from <word> and <word> about the order");
  });
});

describe("hostnames: kept only when they are the app's own outbound hosts", () => {
  it("an unknown host becomes <host>, a known one stays, in text and inside URLs", () => {
    expect(scrub("getaddrinfo ENOTFOUND janes-bakery.example")).toBe("getaddrinfo ENOTFOUND <host>");
    expect(scrub("getaddrinfo ENOTFOUND janes-bakery.example", { knownHost: (h) => h === "janes-bakery.example" })).toBe("getaddrinfo ENOTFOUND janes-bakery.example");
    expect(scrub("Request to https://api.stripe.com/v1/x?email=a%40b.c failed")).toBe("Request to <url> failed");
    expect(scrub("Request to https://api.stripe.com/v1/x?email=a%40b.c failed", opts)).toBe("Request to <url api.stripe.com> failed");
    // A known host is not enough for its URL's path, query or credentials.
    expect(scrub("Request to https://jane:pw@api.stripe.com/users/jane?t=1 failed", opts)).toBe("Request to <url api.stripe.com> failed");
  });

  it("a stored <url host> stays only while the host is known (the server re-checks it)", () => {
    expect(scrub("Request to <url api.stripe.com> failed", opts)).toBe("Request to <url api.stripe.com> failed");
    expect(scrub("Request to <url api.stripe.com> failed")).toBe("Request to <url> failed");
    expect(scrub("Request to <url janes-bakery.example> failed", opts)).toBe("Request to <url> failed");
  });

  it("file names and dotted identifiers are not hostnames", () => {
    expect(scrub("Cannot load config.json for the user")).toBe("Cannot load config.json for the user");
    expect(scrub("Cannot load jane.json for the user")).toBe("Cannot load <word> for the user");
  });
});

describe("typed placeholders", () => {
  it.each([
    ["email", "User jane.doe+shop@mail.example.org not found", "User <email> not found"],
    ["email in mailto", "Send to mailto:jane@example.com failed", "Send to <email> failed"],
    ["email percent-encoded", "user jane%40example.com not found", "user <email> not found"],
    ["email fullwidth", "user ｊａｎｅ＠ｅｘａｍｐｌｅ．ｃｏｍ not found", "user <email> not found"],
    ["email with zero-width", "user ja​ne@exa​mple.com not found", "user <email> not found"],
    ["ipv4 with port", "connect ECONNREFUSED 10.0.3.7:5432", "connect ECONNREFUSED <ip>:5432"],
    ["ipv6", "connect ECONNREFUSED 2001:db8::7 for the user", "connect ECONNREFUSED <ip> for the user"],
    ["mapped", "connect from ::ffff:203.0.113.9 refused for the user", "connect from <ip> refused for the user"],
    ["jwt", "invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here", "invalid token <jwt> here"],
    // A fake key, built from parts so the source holds no key-shaped string.
    ["key", `Invalid API key provided: ${["sk", "live", "51H8xYzAbCdEfGhIjKl"].join("_")}`, "Invalid API key provided: <key>"],
    ["bearer", "Authorization failed: Bearer abc123def456ghi", "Authorization failed: Bearer <key>"],
    ["secret=value", "Invalid password=hunter2 for the account", "Invalid password=<key> for the account"],
    ["card (Luhn)", "Payment for card 4242 4242 4242 4242 was rejected for the user", "Payment for card <card> was rejected for the user"],
    ["iban (mod 97)", "Refund to IBAN GB82 WEST 1234 5698 7654 32 failed for the account", "<word> to IBAN <iban> failed for the account"],
    ["phone", "Call to +44 20 7946 0958 failed for the user", "Call to <phone> failed for the user"],
    ["uuid", "Order d5b9c2e0-2f4c-4a9a-9d1a-3c1f0f7e9b21 failed for the user", "Order <uuid> failed for the user"],
    ["long id", "Order 123456789 failed for the customer", "Order <id> failed for the customer"],
    ["hex id", "Session 9f86d081884c7d659a2f expired for the user", "Session <id> expired for the user"],
    ["prefixed id", "No such customer cus_NffrFeUfNV2Hib for the account", "No such customer <id> for the account"],
    ["base64", "The user amFuZUBleGFtcGxlLmNvbQ== was not found", "The user <token> was not found"],
    ["absolute path", "ENOENT: no such file or directory, open /home/jane/app.json", "ENOENT: no such file or directory, open <path>"],
    ["json blob", 'Failed to load {"email":"jane@example.com","id":42} from the cache', "Failed to load <object> from the cache"],
    ["quoted value", "password authentication failed for user \"jsmith\"", 'password authentication failed for user "<value>"'],
    ["unknown word", "Order for Jane Smith failed", "Order for <word> <word> failed"],
  ])("%s", (_kind, input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it("small numbers, units and codes stay", () => {
    expect(scrub("Request failed with status code 404")).toBe("Request failed with status code 404");
    expect(scrub("timeout of 5000ms exceeded")).toBe("timeout of 5000ms exceeded");
    expect(scrub("listen EADDRINUSE: address already in use :::3000")).toBe("listen EADDRINUSE: address already in use <ip>:3000");
  });
});

describe("error codes: by pattern only", () => {
  it.each([
    ["ECONNREFUSED", "ECONNREFUSED"], ["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_TYPE"], ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"],
    ["P2002", "P2002"], ["23505", "23505"], ["42P01", "42P01"], ["ER_DUP_ENTRY", "ER_DUP_ENTRY"], ["card_declined", "card_declined"],
    ["EMMA", undefined], ["JANES", undefined], ["ERR_JANE_SMITH", undefined], ["jane_smith", undefined], ["jane@example.com", undefined],
    ["E11000 x", undefined], ["", undefined], [42, "42"], [{}, undefined], ["A".repeat(41), undefined],
  ])("%s -> %s", (input, out) => {
    expect(cleanCode(input)).toBe(out);
  });
});

describe("fails closed", () => {
  it("too little left, or too much replaced: no message at all", () => {
    expect(scrub("Jane")).toBeUndefined();
    expect(scrub("jane@example.com")).toBeUndefined();
    expect(scrub("Jane Smith jane@example.com +44 20 7946 0958 failed")).toBeUndefined();
    expect(scrub("ECONNREFUSED")).toBeUndefined();
  });

  it("only the first line is looked at", () => {
    expect(scrub("Upload failed for the user\nstack: at /home/jane/app/src/upload.ts:42 jane@example.com")).toBe("Upload failed for the user");
    expect(scrub("Upload failed for the user\r\njane@example.com")).toBe("Upload failed for the user");
  });

  it("the input is cut before any work, and the output to 200 characters", () => {
    const long = `${"the request failed for the user and ".repeat(40)}jane@example.com`;
    const out = scrub(long)!;
    expect(out.length).toBeLessThanOrEqual(SCRUB_LIMITS.outputMax);
    expect(out.endsWith("...")).toBe(true);
    // An email past the first 1,024 characters is never even looked at.
    expect(scrub(`${"x ".repeat(600)}jane@example.com`)).toBeUndefined();
  });

  it("is a fixed point, and placeholders in the input stay placeholders", () => {
    const once = scrub("User <email> and <word> not found")!;
    expect(once).toBe("User <email> and <word> not found");
    expect(scrub(once)).toBe(once);
  });

  it("lone surrogates, control and format characters", () => {
    expect(scrub("User \ud800 not found in the list")).toBeUndefined();
    expect(scrub("User not\u0007 found in the list")).toBe("User not found in the list");
    expect(scrub("User ‮jane@example.com‬ not found")).toBe("User <email> not found");
  });

  it("never throws, whatever it is given", () => {
    const evil: unknown[] = [
      undefined, null, 42, 42n, Symbol("x"), {}, [], () => "x", new Proxy({}, { get: () => { throw new Error("boom"); } }),
      Object.freeze({ toString: () => { throw new Error("boom"); } }), "x".repeat(10_000_000), "\ud800".repeat(1000), "%".repeat(5000),
      "%E0%A4%A".repeat(100), "<".repeat(5000), "'\"`".repeat(1000), "{[".repeat(5000) + "}]".repeat(5000),
    ];
    for (const e of evil) expect(() => scrub(e)).not.toThrow();
    expect(scrub(42)).toBeUndefined();
    expect(scrub({})).toBeUndefined();
  });
});

describe("bounded cost", () => {
  // A whole 1,024-character input is cheap even when built to be hard. The
  // bounds are generous (shared CI machines, DECISIONS #39); measured locally
  // the worst case is about 1.5 ms at p99.
  const N = 2000;
  const hostile: Record<string, string> = {
    letters: "a".repeat(N), ats: "a@".repeat(N), dots: "1.".repeat(N), quotes: '"'.repeat(N), percent: "%25".repeat(N),
    nested: "{[".repeat(N), base64: "QUJD".repeat(N), digits: "1".repeat(10_000), spacedDigits: "1 ".repeat(N), ibans: "GB82 ".repeat(N),
    unicode: "é𝕏".repeat(N), zwj: "👩‍👩‍👧".repeat(N), angles: "<".repeat(N), urls: "http://".repeat(N), colons: "a:".repeat(N),
    equals: "a=".repeat(N), phones: "+1 ".repeat(N), parens: "(1)".repeat(N), words: "the error ".repeat(N),
    // Found by the property test: a digit run starting inside a URL once stopped the tokenizer advancing (seconds per call).
    urlDigits: "Login failed for https://shop.example.com/x?q=4411856721970093 203.0.113.42 with token",
    urlDigitsRepeated: "https://a.example/x?q=4411856721970093 203.0.113.42 ".repeat(40),
  };

  it.each(Object.entries(hostile))("%s", (_name, input) => {
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      scrub(input);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    // The median is the cost; the p99 bound leaves room for other test files running in parallel.
    expect(times[Math.floor(times.length * 0.5)]!).toBeLessThan(5);
    expect(times[Math.floor(times.length * 0.99)]!).toBeLessThan(25);
  });

  it("random mixes of hostile fragments: every call stays fast", () => {
    const fragments = [
      "https://a.example/?q=", "4411856721970093", " ", "203.0.113.42", ":", "'", '"', "`", "{", "[", "]", "}", "<", ">", "<url a.example>",
      "%2B", "%", "@", "=", "the", "error", "GB82", "WEST", "+44", "(", ")", "-", ".", "\u200b", "é", "\n", "jane@example.com", "eyJhbGc.eyJ.x",
    ];
    let state = 99;
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    let worst = 0;
    for (let n = 0; n < 2000; n++) {
      let s = "";
      while (s.length < 1100) s += fragments[Math.floor(next() * fragments.length)];
      const t = performance.now();
      scrub(s);
      worst = Math.max(worst, performance.now() - t);
    }
    expect(worst).toBeLessThan(50);
  });

  it("a URL followed by digits and an IP is read correctly, not only quickly", () => {
    expect(scrub("Login failed for https://shop.example.com/x?q=4411856721970093 203.0.113.42 with token")).toBe("Login failed for <url> <ip> with token");
  });

  it("10,000,000 characters cost no more than 1,024: the cut comes first", () => {
    const time = (s: string) => {
      const t = performance.now();
      for (let i = 0; i < 50; i++) scrub(s);
      return performance.now() - t;
    };
    const short = "the error 1 ".repeat(85);
    const long = "the error 1 ".repeat(850_000);
    time(short);
    expect(time(long)).toBeLessThan(time(short) * 3 + 5);
  });

  it("no pattern in the scrubber has a nested quantifier", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/scrub.ts", import.meta.url)), "utf8");
    const patterns = [...src.matchAll(/\/((?:\\.|[^/\n\\])+)\/[gimsuy]*[.;,)\s]/g)].map((m) => m[1]!).filter((p) => /[+*{]/.test(p));
    expect(patterns.length).toBeGreaterThan(10);
    for (const p of patterns) {
      // A group that contains a quantifier and is itself repeated without bound: (a+)+, (?:x*)*, (..+){2,}.
      // A bounded repeat of a bounded group, (?:\.\d{1,3}){3}, cannot backtrack catastrophically.
      expect(p, p).not.toMatch(/\((?:[^()]|\\\(|\\\))*[+*}](?:[^()]|\\\(|\\\))*\)(?:[+*]|\{\d+,\})/);
      // No backreferences or lookbehind.
      expect(p, p).not.toMatch(/\\[1-9]|\(\?<[=!]/);
    }
  });
});
