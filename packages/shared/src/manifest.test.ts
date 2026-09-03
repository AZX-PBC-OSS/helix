import { describe, expect, it } from "vitest";
import { AppManifestSchema, isValidServiceWorkerScope } from "./manifest.js";
import { VisibilitySchema } from "./visibility.js";

describe("AppManifestSchema", () => {
  it("parses the §6.3 example manifest and fills capability defaults", () => {
    const parsed = AppManifestSchema.parse({
      app: "cost-explorer",
      visibility: { mode: "internal" },
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
    // ADR-0042: the prefix arrays default alongside the literal ones.
    expect(parsed.capabilities.data?.sharedReadPrefixes).toEqual([]);
    expect(parsed.capabilities.data?.sharedWritePrefixes).toEqual([]);
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
      visibility: { mode: "internal" },
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

  it("requires a group list for group visibility", () => {
    expect(VisibilitySchema.safeParse({ mode: "group" }).success).toBe(false);
    expect(VisibilitySchema.safeParse({ mode: "group", groupIds: ["eng-team"] }).success).toBe(
      true,
    );
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
    const parsed = AppManifestSchema.parse({ app: "x", visibility: { mode: "internal" } });
    expect(parsed.capabilities.offline).toBeUndefined();
  });
});

describe("shared prefix grants (ADR-0042)", () => {
  it("parses both prefix arrays", () => {
    const parsed = CapabilitiesParse({
      data: { sharedReadPrefixes: ["record:", "cfg:public:"] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capabilities.data?.sharedReadPrefixes).toEqual(["record:", "cfg:public:"]);
    }
  });

  it("rejects an empty prefix — it would grant the whole scope", () => {
    expect(CapabilitiesParse({ data: { sharedReadPrefixes: [""] } }).success).toBe(false);
    expect(CapabilitiesParse({ data: { sharedWritePrefixes: [""] } }).success).toBe(false);
  });

  it("rejects a prefix over 256 UTF-8 bytes, counting multibyte correctly", () => {
    // 128 CJK chars = 384 UTF-8 bytes but only 128 UTF-16 code units — the same
    // undercounting issue #12 fixed for values, applied to the grant itself.
    const wide = "漢".repeat(128);
    expect(CapabilitiesParse({ data: { sharedReadPrefixes: [wide] } }).success).toBe(false);
    // 85 CJK chars = 255 bytes — one under the cap, still legal.
    expect(CapabilitiesParse({ data: { sharedReadPrefixes: ["漢".repeat(85)] } }).success).toBe(
      true,
    );
  });

  it("rejects control characters — CR/LF here is header/URL-borne injection surface", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    for (const bad of [`re${CR}cord:`, `re${LF}cord:`, `re${NUL}cord:`]) {
      expect(CapabilitiesParse({ data: { sharedWritePrefixes: [bad] } }).success, bad).toBe(false);
    }
  });

  it("leaves the literal arrays at their historical lenience — no retroactive tightening", () => {
    // The literal arrays predate the prefix fields and carry only `min(1)`; the
    // stricter key rules are for the NEW fields only, so a live manifest that
    // was legal yesterday cannot start failing validation today.
    expect(CapabilitiesParse({ data: { sharedRead: ["漢".repeat(128)] } }).success).toBe(true);
  });
});

// Small helper to keep the URL-rejection assertion readable.
function CapabilitiesParse(capabilities: unknown) {
  return AppManifestSchema.safeParse({
    app: "x",
    visibility: { mode: "internal" },
    capabilities,
  });
}
