import { describe, expect, it } from "vitest";
import {
  FLOW_COOKIE,
  SESSION_COOKIE,
  clearFlowCookie,
  clearSessionCookie,
  parseCookieHeader,
  serializeFlowCookie,
  serializeSessionCookie,
} from "./cookies.js";

describe("parseCookieHeader", () => {
  it("parses simple pairs and trims whitespace", () => {
    const jar = parseCookieHeader("a=1; b=2;c=3");
    expect(jar.get("a")).toBe("1");
    expect(jar.get("b")).toBe("2");
    expect(jar.get("c")).toBe("3");
  });

  it("returns empty for absent or junk headers", () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader("").size).toBe(0);
    expect(parseCookieHeader("no-equals-here; ;;").size).toBe(0);
  });

  it("unquotes quoted values", () => {
    expect(parseCookieHeader('a="hello"').get("a")).toBe("hello");
    // A lone quote is not a quoted pair.
    expect(parseCookieHeader('a="x').get("a")).toBe('"x');
  });

  it("keeps values containing '='", () => {
    expect(parseCookieHeader("t=abc=def==").get("t")).toBe("abc=def==");
  });

  it("treats conflicting duplicate names as absent (ambiguity is rejected)", () => {
    const jar = parseCookieHeader(`${SESSION_COOKIE}=real; ${SESSION_COOKIE}=forged; other=1`);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(jar.get("other")).toBe("1");
  });

  it("collapses duplicate names with identical values", () => {
    expect(parseCookieHeader("a=same; a=same").get("a")).toBe("same");
  });

  it("is exact about names — near-miss shadow cookies do not match", () => {
    const jar = parseCookieHeader(`session=evil; __host-session=evil; _Host-session=evil`);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(jar.get("session")).toBe("evil"); // present, but nothing reads it
  });
});

describe("serializers", () => {
  it("emits __Host- compliant attributes (Secure, Path=/, no Domain)", () => {
    const cookie = serializeSessionCookie("abc123", 3600);
    expect(cookie).toBe(
      `${SESSION_COOKIE}=abc123; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
    );
    expect(cookie).not.toContain("Domain");

    expect(serializeFlowCookie("x.y.z", 600)).toContain(`${FLOW_COOKIE}=x.y.z; Path=/; Secure`);
  });

  it("clears with Max-Age=0 and the same attributes", () => {
    expect(clearSessionCookie()).toBe(
      `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    expect(clearFlowCookie()).toContain("Max-Age=0");
  });

  it("refuses values outside the emitted charset (header-injection guard)", () => {
    expect(() => serializeSessionCookie("evil;Path=/x", 60)).toThrow(/charset/);
    expect(() => serializeSessionCookie("a\r\nSet-Cookie: b", 60)).toThrow(/charset/);
    expect(() => serializeFlowCookie("", 60)).toThrow(/charset/);
  });
});
