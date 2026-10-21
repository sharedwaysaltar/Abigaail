// Property test (DECISIONS #106): realistic personal data, in every encoding
// an app might hand over, put into real error messages at every position.
// Whatever the scrubber makes of it holds none of it, is at most 200
// characters, and is a fixed point. Seeded: a failure prints its seed.

import { describe, expect, it } from "vitest";
import { isScrubbed, scrub, SCRUB_LIMITS } from "@abigaail/schema";
import { CORPUS, KNOWN_HOSTS } from "./fixtures/error-corpus.js";
import { encode, leaks, pick, pii, rng, type Pii, type Rng } from "./pii.js";

const known = new Set(KNOWN_HOSTS);
const opts = { knownHost: (h: string) => known.has(h) };
const templates = CORPUS.filter((c) => c.expected !== null).map((c) => c.input);

/** Put the value into the text: replacing a word, after a word, quoted, in brackets, as key=value, in a URL. */
function plant(r: Rng, template: string, p: Pii): string {
  const words = template.split(" ");
  const at = Math.floor(r() * (words.length + 1));
  const form = pick(r, [
    p.text,
    `'${p.text}'`,
    `"${p.text}"`,
    `(${p.text})`,
    `user=${p.text}`,
    `https://shop.example.com/x?q=${encodeURIComponent(p.text)}`,
    `${p.text}:`,
    `[${p.text}]`,
  ]);
  if (r() < 0.3 && at < words.length) words[at] = form;
  else words.splice(at, 0, form);
  return words.join(" ");
}

describe("no personal data survives the scrubber", () => {
  it("5,000 generated cases", () => {
    const failures: string[] = [];
    let kept = 0;
    for (let seed = 1; seed <= 5000; seed++) {
      const r = rng(seed);
      const value = r() < 0.5 ? encode(r, pii(r)) : pii(r);
      const input = plant(r, pick(r, templates), value);
      const out = scrub(input, opts);
      if (out === undefined) continue;
      kept++;
      const found = leaks(out, value);
      if (found.length) failures.push(`seed ${seed} (${value.kind}): ${JSON.stringify(input)} -> ${JSON.stringify(out)} leaks ${found.join(", ")}`);
      if (out.length > SCRUB_LIMITS.outputMax) failures.push(`seed ${seed}: ${out.length} characters`);
      if (!isScrubbed(out, opts)) failures.push(`seed ${seed}: not a fixed point: ${JSON.stringify(out)}`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
    // Not vacuous: most cases still carry a useful message.
    expect(kept).toBeGreaterThan(3000);
  });

  it("several values at once, and values alone", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 1000; seed++) {
      const r = rng(100_000 + seed);
      const values = [pii(r), encode(r, pii(r)), pii(r)];
      let input = pick(r, templates);
      for (const v of values) input = plant(r, input, v);
      const out = scrub(input, opts);
      for (const v of values) {
        const found = out === undefined ? [] : leaks(out, v);
        if (found.length) failures.push(`seed ${100_000 + seed} (${v.kind}): ${JSON.stringify(out)} leaks ${found.join(", ")}`);
      }
      // A value on its own is never a message.
      const alone = scrub(values[0]!.text, opts);
      if (alone !== undefined && leaks(alone, values[0]!).length) failures.push(`alone ${seed}: ${alone}`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it("the leak check itself catches a planted value (control)", () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const v = pii(r);
      // The raw text, unscrubbed, is a leak by the same check.
      if (v.needles.length || v.digits) expect(leaks(`error: ${v.text} here`, v).length, `${v.kind} ${v.text} ${JSON.stringify(v.needles)} ${v.digits}`).toBeGreaterThan(0);
    }
  });
});
