import { describe, expect, it } from "vitest";
import { RouteNormaliser, heuristicRoute, pathOnly } from "@abigaail/core";

describe("pathOnly", () => {
  it("drops query strings, fragments, scheme and host", () => {
    expect(pathOnly("/reset?token=abc&email=a@b.c")).toBe("/reset");
    expect(pathOnly("/page#section")).toBe("/page");
    expect(pathOnly("https://app.example.com/a/b?x=1")).toBe("/a/b");
    expect(pathOnly("https://app.example.com")).toBe("/");
    expect(pathOnly("//a///b")).toBe("/a/b");
  });
});

describe("heuristicRoute", () => {
  it.each([
    ["/user/123", "/user/[id]"],
    ["/user/123/posts/456", "/user/[id]/posts/[id]"],
    ["/order/3f2b8c1e-9a4d-4e7f-8b2a-1c5d6e7f8a9b", "/order/[id]"],
    ["/commit/a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", "/commit/[id]"],
    ["/s/Ab3dEf9hIj2kLm4nOp6q", "/s/[id]"],
    ["/u/jane@example.com", "/u/[id]"],
    ["/caf%C3%A9", "/[id]"],
    ["/api/chat", "/api/chat"],
    ["/api/v1/users", "/api/v1/users"],
    // Fails closed (DECISIONS #108): a slug, handle, name or address it does not know is never a route.
    ["/blog/hello-world", "/blog/[id]"],
    ["/users/raybrown46", "/users/[id]"],
    ["/amelia_kim68/settings", "/[id]/settings"],
    ["/u/Jane/profile", "/u/[id]/profile"],
    ["/u/grant", "/u/[id]"],
    ["/203.0.113.9/status", "/[id]/status"],
    ["/", "/"],
  ])("%s -> %s", (input, expected) => {
    expect(heuristicRoute(input)).toBe(expected);
  });

  it("never lets a query value through", () => {
    expect(heuristicRoute("/search?q=jane+smith")).toBe("/search");
  });
});

describe("RouteNormaliser with known patterns", () => {
  const n = () =>
    new RouteNormaliser({
      patterns: [
        "/",
        "/user/[id]",
        "/user/me",
        "/docs/[...slug]",
        "/shop/[[...path]]",
        "/(marketing)/pricing",
        "/api/studies/by-conversation/[conversationId]",
      ],
    });

  it.each([
    ["/", "/"],
    ["/user/42", "/user/[id]"],
    ["/user/me", "/user/me"],
    ["/user/42/", "/user/[id]"],
    ["/docs/a/b/c", "/docs/[...slug]"],
    ["/shop", "/shop/[[...path]]"],
    ["/shop/x/y", "/shop/[[...path]]"],
    ["/pricing", "/pricing"],
    ["/api/studies/by-conversation/abc?x=1", "/api/studies/by-conversation/[conversationId]"],
  ])("%s -> %s", (input, expected) => {
    expect(n().normalise(input)).toBe(expected);
  });

  it("falls back to the heuristic for unknown paths", () => {
    expect(n().normalise("/orders/99")).toBe("/orders/[id]");
  });

  it("match() returns the known pattern or undefined, without counting a route", () => {
    expect(n().match("/user/999")).toBe("/user/[id]");
    expect(n().match("/.env")).toBeUndefined();
  });

  it.each([
    ["/(marketing)/@modal/user/[id]", "/user/[id]"],
    ["/(shop)/cart", "/cart"],
    ["/api/[slug]/page", "/api/[slug]/page"],
    ["/user/a b", "other"],
    ["/user/%41", "other"],
  ])("pattern(%s) -> %s", (input, expected) => {
    expect(n().pattern(input)).toBe(expected);
  });

  it("can report unknown paths as 'unmatched' instead", () => {
    const strict = new RouteNormaliser({ patterns: ["/a"], fallback: "unmatched" });
    expect(strict.normalise("/wp-login.php")).toBe("unmatched");
  });
});

describe("cardinality cap", () => {
  it("folds routes beyond maxRoutes into 'other'", () => {
    const n = new RouteNormaliser({ maxRoutes: 3 });
    expect(n.normalise("/a")).toBe("/a");
    expect(n.normalise("/b")).toBe("/b");
    expect(n.normalise("/c")).toBe("/c");
    expect(n.normalise("/d")).toBe("other");
    // Routes already seen keep reporting normally.
    expect(n.normalise("/a")).toBe("/a");
  });

  it("stays bounded under a flood of unique slugs", () => {
    const n = new RouteNormaliser({ maxRoutes: 500 });
    const routes = new Set<string>();
    for (let i = 0; i < 10_000; i++) routes.add(n.normalise(`/blog/post-title-${String.fromCharCode(97 + (i % 26))}${i.toString(36)}x`));
    expect(routes.size).toBeLessThanOrEqual(501);
  });
});
