import { describe, expect, it } from "vitest";
import { clampRecord, errorDetailOf, fetchPathOf, MODEL_MAX, PATH_MAX } from "./usage.js";
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

/**
 * `fetchPathOf` — the `path` ledger column. Two invariants: the value is capped
 * (it is attacker-controlled, and no role holds DELETE on `gateway_calls`), and
 * a query string never reaches it (callers pass `URL.pathname`, so the target's
 * credentials-bearing query is gone before this point).
 */
describe("fetchPathOf", () => {
  it("passes an ordinary path through untouched", () => {
    expect(fetchPathOf("/users/octocat")).toBe("/users/octocat");
  });

  it("truncates a pathological path to the ledger column budget", () => {
    const path = fetchPathOf(`/${"a".repeat(PATH_MAX + 200)}`);

    expect(path).toHaveLength(PATH_MAX + 1);
    expect(path.endsWith("…")).toBe(true);
  });
});

/**
 * `clampRecord` — the store-level backstop. `path` arrives pre-capped via
 * `fetchPathOf`, but `model` and `errorDetail` are built by call sites from
 * `target.origin`, whose only bound is Node's `maxHeaderSize`. Shared by
 * `PgUsageStore` and the test fake so both agree on what gets stored.
 */
describe("clampRecord", () => {
  const base = {
    appId: "a",
    env: "prod" as const,
    userOid: "u",
    capability: "fetch",
    model: "https://api.github.com",
    inputTokens: 0,
    outputTokens: 0,
    outcome: "ok" as const,
  };

  it("leaves an ordinary record untouched", () => {
    const r = clampRecord({ ...base, path: "/users/octocat", errorDetail: null });
    expect(r.model).toBe("https://api.github.com");
    expect(r.path).toBe("/users/octocat");
  });

  it("caps an absurd origin in `model`", () => {
    const r = clampRecord({ ...base, model: `https://${"h".repeat(MODEL_MAX + 500)}` });
    expect(r.model).toHaveLength(MODEL_MAX + 1);
    expect(r.model.endsWith("…")).toBe(true);
  });

  it("caps `errorDetail` built by a call site rather than by errorDetailOf", () => {
    const r = clampRecord({ ...base, errorDetail: `origin ${"x".repeat(4000)} is not proxied` });
    expect(r.errorDetail).toHaveLength(301);
  });

  it("is idempotent on an already-capped path", () => {
    const once = clampRecord({ ...base, path: fetchPathOf(`/${"a".repeat(PATH_MAX + 100)}`) });
    const twice = clampRecord(once);
    expect(twice.path).toEqual(once.path);
    expect(twice.path).toHaveLength(PATH_MAX + 1);
  });

  it("leaves an absent path and errorDetail absent rather than nulling them", () => {
    const r = clampRecord(base);
    expect("path" in r).toBe(false);
    expect("errorDetail" in r).toBe(false);
  });
});
