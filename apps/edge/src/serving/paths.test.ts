import { describe, expect, it } from "vitest";
import { normalizeRequestPath } from "./paths.js";

describe("normalizeRequestPath", () => {
  it.each([
    ["/", "/"],
    ["/index.html", "/index.html"],
    ["/assets/app.js", "/assets/app.js"],
    ["/a//b", "/a/b"], // empty segments collapse
    ["/assets/app.js?v=3", "/assets/app.js"], // query stripped
    ["/page#section", "/page"], // fragment stripped
    ["/caf%C3%A9.png", "/café.png"], // unicode decodes fine
    ["/a/b/", "/a/b"], // trailing slash drops
  ])("accepts %s as %s", (input, expected) => {
    expect(normalizeRequestPath(input)).toBe(expected);
  });

  it.each([
    "/../etc/passwd",
    "/a/../b",
    "/a/..",
    "/.",
    "/%2e%2e/x", // encoded ..
    "/a/%2E%2E/b", // mixed-case encoded ..
    "/a/..%2fb", // .. with encoded slash
    "/a%5cb", // encoded backslash
    "/a\\b", // raw backslash
    "/%2500", // double-encoded NUL
    "/a%252e%252e", // double-encoded dots (residual % after decode)
    "/%00", // encoded NUL
    "/%zz", // malformed encoding
    "no-leading-slash",
    "",
  ])("rejects %s", (input) => {
    expect(normalizeRequestPath(input)).toBeNull();
  });

  it("rejects control characters after decoding", () => {
    expect(normalizeRequestPath("/a%0d%0ab")).toBeNull();
    expect(normalizeRequestPath("/a%7fb")).toBeNull();
  });
});
