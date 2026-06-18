import { describe, expect, it } from "vitest";
import { APP_CSP, buildAppCsp } from "./csp.js";

function parse(csp: string): Map<string, string> {
  return new Map(
    csp.split("; ").map((d) => {
      const space = d.indexOf(" ");
      return space === -1 ? [d, ""] : [d.slice(0, space), d.slice(space + 1)];
    }),
  );
}

const directives = parse(APP_CSP);

// The strict directives ARE the containment (architecture §4.4). If one of
// these assertions fails, a diff loosened the data-flow boundary — that is a
// security review, not a test update.
describe("APP_CSP strict data-flow directives", () => {
  it("pins connect-src to 'self' exactly", () => {
    expect(directives.get("connect-src")).toBe("'self'");
  });

  it("pins form-action to 'self' exactly (cross-app CSRF, §4.2)", () => {
    expect(directives.get("form-action")).toBe("'self'");
  });

  it("pins frame-ancestors to 'none' exactly", () => {
    expect(directives.get("frame-ancestors")).toBe("'none'");
  });

  it("pins base-uri to 'self' exactly", () => {
    expect(directives.get("base-uri")).toBe("'self'");
  });
});

describe("APP_CSP relaxed code-provenance directives", () => {
  it("permits inline scripts and eval (vibe-coded single-file apps)", () => {
    const script = directives.get("script-src") ?? "";
    expect(script).toContain("'unsafe-inline'");
    expect(script).toContain("'unsafe-eval'");
    expect(script).toContain("'wasm-unsafe-eval'");
  });

  it("keeps img-src open (honest trade-off, §4.4)", () => {
    expect(directives.get("img-src")).toBe("https: data: blob:");
  });
});

describe("buildAppCsp — per-app external origins (§6.2)", () => {
  it("widens connect-src and img-src with approved origins", () => {
    const d = parse(buildAppCsp(["https://api.foo.com", "https://b.example.com"]));
    expect(d.get("connect-src")).toBe("'self' https://api.foo.com https://b.example.com");
    expect(d.get("img-src")).toBe("https: data: blob: https://api.foo.com https://b.example.com");
  });

  it("normalizes a URL with a path down to its origin and dedupes", () => {
    const d = parse(buildAppCsp(["https://api.foo.com/v1", "https://api.foo.com/v2"]));
    expect(d.get("connect-src")).toBe("'self' https://api.foo.com");
  });

  it("drops invalid origins (fail-closed — never widen on garbage)", () => {
    const d = parse(buildAppCsp(["not a url", ""]));
    expect(d.get("connect-src")).toBe("'self'");
  });

  it("with no origins equals the strict baseline", () => {
    const d = parse(buildAppCsp());
    expect(d.get("connect-src")).toBe("'self'");
    expect(d.get("img-src")).toBe("https: data: blob:");
  });

  it("always points report-uri at the same-origin sink", () => {
    expect(parse(buildAppCsp()).get("report-uri")).toBe("/_csp-report");
    expect(parse(buildAppCsp(["https://api.foo.com"])).get("report-uri")).toBe("/_csp-report");
  });
});
