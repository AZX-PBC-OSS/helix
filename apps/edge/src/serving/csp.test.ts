import { describe, expect, it } from "vitest";
import { APP_CSP } from "./csp.js";

const directives = new Map(
  APP_CSP.split("; ").map((d) => {
    const space = d.indexOf(" ");
    return space === -1 ? [d, ""] : [d.slice(0, space), d.slice(space + 1)];
  }),
);

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
