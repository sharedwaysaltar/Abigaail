import { describe, expect, it } from "vitest";
import { classifyUserAgent, eventTime, MAX_EVENT_AGE_MS, utcDay, TokenBucket } from "@abigaail/server";

describe("eventTime", () => {
  it("subtracts the client-side wait from the receive time", () => {
    expect(eventTime(10_000, 5_000, 4_000)).toBe(9_000);
    expect(eventTime(10_000, undefined, 4_000)).toBe(10_000);
    expect(eventTime(10_000, 4_000, 5_000)).toBe(10_000);
    expect(eventTime(MAX_EVENT_AGE_MS * 3, MAX_EVENT_AGE_MS * 2, 0)).toBe(MAX_EVENT_AGE_MS * 2);
  });
});

describe("utcDay", () => {
  it("uses UTC, not local time", () => {
    expect(utcDay(Date.UTC(2026, 9, 18, 23, 59, 59))).toBe("2026-10-18");
    expect(utcDay(Date.UTC(2026, 9, 19, 0, 0, 0))).toBe("2026-10-19");
  });
});

describe("classifyUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "human", "chrome"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0", "human", "edge"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "human", "firefox"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", "human", "safari"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "crawler", null],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "ai_crawler", null],
    ["Mozilla/5.0 (compatible; ClaudeBot/1.0)", "ai_crawler", null],
    ["curl/8.5.0", "automation", null],
    ["python-requests/2.32", "automation", null],
    [undefined, "unknown", null],
  ])("%s", (ua, bot_class, browser) => {
    expect(classifyUserAgent(ua)).toEqual({ bot_class, browser });
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then refills at the rate", () => {
    let t = 0;
    const b = new TokenBucket(2, 3, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t = 500;
    expect([b.take(), b.take()]).toEqual([true, false]);
  });
});
