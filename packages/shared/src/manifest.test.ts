import { describe, expect, it } from "vitest";
import { AppManifestSchema, isValidServiceWorkerScope } from "./manifest.js";
import { VisibilitySchema } from "./visibility.js";

describe("AppManifestSchema", () => {
  it("parses the §6.3 example manifest and fills capability defaults", () => {
    const parsed = AppManifestSchema.parse({
      app: "cost-explorer",
      visibility: { mode: "private" },
      capabilities: {
        llm: { models: ["gpt-5", "claude-fable-5"], dollarsPerDay: 20 },
        data: { user: true, collections: ["contacts"] },
        mcp: ["azure-billing"],
      },
    });

    expect(parsed.app).toBe("cost-explorer");
    // externalOrigins defaulted even though it was omitted.
    expect(parsed.capabilities.externalOrigins).toEqual([]);
    expect(parsed.capabilities.llm?.dollarsPerDay).toBe(20);
    // data sub-arrays default even when only some keys are given.
    expect(parsed.capabilities.data?.user).toBe(true);
    expect(parsed.capabilities.data?.collections).toEqual(["contacts"]);
    expect(parsed.capabilities.data?.sharedRead).toEqual([]);
    expect(parsed.capabilities.data?.sharedWrite).toEqual([]);
  });

  it("applies a baseline capabilities block when omitted entirely", () => {
    const parsed = AppManifestSchema.parse({
      app: "hello",
      visibility: { mode: "public" },
    });
    expect(parsed.capabilities.mcp).toEqual([]);
    expect(parsed.capabilities.externalOrigins).toEqual([]);
  });

  it("rejects non-URL external origins", () => {
    const result = CapabilitiesParse({ externalOrigins: ["not a url"] });
    expect(result.success).toBe(false);
  });

  it("parses the fetch capability with defaults and keyless/bound origins", () => {
    const parsed = AppManifestSchema.parse({
      app: "stars",
      visibility: { mode: "private" },
      capabilities: {
        fetch: {
          origins: [
            { origin: "https://api.github.com" },
            { origin: "https://api.stripe.com", connection: "stripe-live" },
          ],
        },
      },
    });
    expect(parsed.capabilities.fetch?.shim).toBe(false); // defaulted
    expect(parsed.capabilities.fetch?.origins).toHaveLength(2);
    expect(parsed.capabilities.fetch?.origins[1]?.connection).toBe("stripe-live");
    // externalOrigins (direct) is untouched and independent of fetch (proxy).
    expect(parsed.capabilities.externalOrigins).toEqual([]);
  });

  it("rejects a non-URL proxied origin", () => {
    const result = CapabilitiesParse({ fetch: { origins: [{ origin: "nope" }] } });
    expect(result.success).toBe(false);
  });

  it("requires a groupId for group visibility", () => {
    expect(VisibilitySchema.safeParse({ mode: "group" }).success).toBe(false);
    expect(VisibilitySchema.safeParse({ mode: "group", groupId: "eng-team" }).success).toBe(true);
  });
});

describe("offline capability scope (ADR-0035 §3)", () => {
  it("accepts an ordinary non-root prefix, nested included", () => {
    for (const scope of ["/app/", "/shell/", "/a/b/", "/App-2/"]) {
      expect(isValidServiceWorkerScope(scope)).toBe(true);
      expect(CapabilitiesParse({ offline: { scope } }).success).toBe(true);
    }
  });

  it("refuses root — the whole point of confinement", () => {
    expect(isValidServiceWorkerScope("/")).toBe(false);
    expect(CapabilitiesParse({ offline: { scope: "/" } }).success).toBe(false);
  });

  it("refuses any `_`-leading first segment, not just today's namespaces", () => {
    // The reserved namespaces...
    for (const scope of ["/_auth/", "/_api/", "/_helix/"]) {
      expect(isValidServiceWorkerScope(scope)).toBe(false);
    }
    // ...and one that does not exist yet, which is the point of the rule.
    expect(isValidServiceWorkerScope("/_future/")).toBe(false);
    // Only the FIRST segment is reserved; `_` deeper is an ordinary directory.
    expect(isValidServiceWorkerScope("/app/_next/")).toBe(true);
  });

  it("refuses doubled slashes, which the edge would reject anyway", () => {
    // The drift this closes: these used to pass here and fail in the edge's
    // projection, so an owner could get an approved elevated grant that
    // projected to nothing, with no error surfaced anywhere.
    for (const scope of ["/app//", "//app/", "/app//sub/", "///"]) {
      expect(isValidServiceWorkerScope(scope), scope).toBe(false);
      expect(CapabilitiesParse({ offline: { scope } }).success, scope).toBe(false);
    }
  });

  it("requires both a leading and a trailing slash", () => {
    expect(isValidServiceWorkerScope("/app")).toBe(false);
    expect(isValidServiceWorkerScope("app/")).toBe(false);
    expect(isValidServiceWorkerScope("")).toBe(false);
  });

  it("refuses traversal, encoding, whitespace and control characters", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    for (const scope of [
      "/app/../",
      "/../app/",
      "/./app/",
      "/app/%2e%2e/",
      "/app%2f/",
      "/app" + String.fromCharCode(92) + "/",
      "/app /",
      "/app" + NUL + "/",
      // A CR/LF would be header injection — the scope is emitted verbatim as
      // the `Service-Worker-Allowed` response header value.
      "/app" + CR + LF + "/",
      "/app" + LF + "X-Evil: 1/",
    ]) {
      expect(isValidServiceWorkerScope(scope)).toBe(false);
      expect(CapabilitiesParse({ offline: { scope } }).success).toBe(false);
    }
  });

  it("is absent unless declared — no default grant", () => {
    const parsed = AppManifestSchema.parse({ app: "x", visibility: { mode: "private" } });
    expect(parsed.capabilities.offline).toBeUndefined();
  });
});

// Small helper to keep the URL-rejection assertion readable.
function CapabilitiesParse(capabilities: unknown) {
  return AppManifestSchema.safeParse({
    app: "x",
    visibility: { mode: "private" },
    capabilities,
  });
}
