import { describe, expect, it } from "vitest";
import { errorDetailOf } from "./usage.js";
import { EgressProviderError } from "./egressProvider.js";

/**
 * `errorDetailOf` — what the ledger's `errorDetail` column gets to say about a
 * failure. Regression cover for a live incident: an edge→egress DNS failure
 * recorded as the bare string "egress request failed", identical to every other
 * transport failure, because the `ENOTFOUND` in the cause was dropped here.
 */

describe("errorDetailOf", () => {
  it("keeps the wire-level code from a wrapped egress transport failure", () => {
    const cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND azx-helix-egress.internal.example.azurecontainerapps.io"),
      { code: "ENOTFOUND" },
    );
    const detail = errorDetailOf(new EgressProviderError("egress request failed", { cause }));

    expect(detail).toContain("egress request failed");
    expect(detail).toContain("ENOTFOUND");
  });

  it("distinguishes a refused connection from a DNS failure", () => {
    const refused = errorDetailOf(
      new EgressProviderError("egress request failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.5.166:443"), {
          code: "ECONNREFUSED",
        }),
      }),
    );

    expect(refused).toContain("ECONNREFUSED");
    expect(refused).not.toContain("ENOTFOUND");
  });

  it("records a plain error unchanged when there is no cause", () => {
    expect(errorDetailOf(new Error("upstream said no"))).toBe("upstream said no");
  });

  it("handles a non-Error throw", () => {
    expect(errorDetailOf("something odd")).toBe("something odd");
  });

  it("truncates to the ledger column budget", () => {
    const detail = errorDetailOf(new Error("x".repeat(500)));

    expect(detail).toHaveLength(301);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("stops walking a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    expect(() => errorDetailOf(b)).not.toThrow();
  });
});
