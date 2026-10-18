import { describe, expect, it } from "vitest";
import { errorType, parseStack, relativePath } from "@abigaail/node";

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
