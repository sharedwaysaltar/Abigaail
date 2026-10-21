import { describe, expect, it } from "vitest";
import { errorCodeOf, errorDetail, errorType, parseStack, relativePath } from "@abigaail/node";

describe("relativePath", () => {
  const root = "/home/jane/app";
  it.each([
    ["/home/jane/app/src/a.ts", "src/a.ts"],
    ["file:///home/jane/app/src/b.ts", "src/b.ts"],
    ["webpack-internal:///(rsc)/./src/app/page.tsx", "src/app/page.tsx"],
    ["/home/jane/other/x.ts", undefined],
    ["/home/jane/application/x.ts", undefined],
    ["node:internal/process/task_queues", undefined],
    ["C:\\Users\\jane\\x.ts", undefined],
    ["https://cdn.example/x.js", undefined],
  ])("%s -> %s", (input, expected) => {
    expect(relativePath(input, root)).toBe(expected);
  });
});

describe("parseStack", () => {
  it("parses named, anonymous and async frames and skips message lines", () => {
    const err = new Error("first line\n    at fake (/home/jane/app/leak.ts:1:1) from the message");
    err.stack = [
      "Error: first line",
      "    at fake (/home/jane/app/leak.ts:1:1) from the message",
      "    at async GET (/home/jane/app/src/route.ts:10:5)",
      "    at /home/jane/app/src/anon.ts:3:7",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");
    expect(parseStack(err, "/home/jane/app")).toEqual([
      { file: "src/route.ts", line: 10, col: 5, fn: "GET" },
      { file: "src/anon.ts", line: 3, col: 7 },
    ]);
  });

  it("errorType never uses the message", () => {
    expect(errorType(new TypeError("jane@example.com"))).toBe("TypeError");
    expect(errorType({ message: "x" })).toBe("NonError");
  });
});

describe("errorDetail: reads message, code and cause without running app code (DECISIONS #105)", () => {
  it("own data properties only; one level of cause", () => {
    const cause = Object.assign(new TypeError("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
    const err = Object.assign(new Error("fetch failed", { cause }), { code: "UND_ERR_SOCKET", email: "jane@example.com" });
    expect(errorDetail(err)).toEqual({
      message: "fetch failed", code: "UND_ERR_SOCKET", cause_type: "TypeError", cause_code: "ECONNREFUSED", cause_message: "connect ECONNREFUSED 10.0.0.1:5432",
    });
    expect(errorDetail("thrown string")).toEqual({ message: "thrown string" });
    expect(errorDetail({ message: "an object" })).toEqual({});
  });

  it("a throwing or slow getter, a Proxy or a cause cycle never runs and never throws", () => {
    let ran = false;
    const getters = new Error("x");
    Object.defineProperty(getters, "message", { get: () => { ran = true; throw new Error("boom"); } });
    Object.defineProperty(getters, "code", { get: () => { ran = true; return "ECONNRESET"; } });
    expect(errorDetail(getters)).toEqual({});
    expect(ran).toBe(false);

    const proxy = new Proxy(new Error("y"), { getOwnPropertyDescriptor: () => { throw new Error("trap"); }, get: () => { throw new Error("trap"); } });
    expect(() => errorDetail(proxy)).not.toThrow();

    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(errorDetail(a)).toMatchObject({ message: "a", cause_message: "b" });
    expect(errorDetail(new Error("z".repeat(10_000))).message!.length).toBe(2048);
  });

  it("errorCodeOf takes the error's code or its cause's", () => {
    expect(errorCodeOf(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe("ENOTFOUND");
    expect(errorCodeOf(new TypeError("fetch failed", { cause: Object.assign(new Error("y"), { code: "ECONNREFUSED" }) }))).toBe("ECONNREFUSED");
    expect(errorCodeOf("x")).toBeUndefined();
  });
});
