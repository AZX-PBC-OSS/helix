import { describe, expect, it } from "vitest";
import { AppManifestSchema, FetchConnectionSchema, isValidServiceWorkerScope } from "./manifest.js";
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

  // ADR-0043: keys, prefixes, and collection names are printable-ASCII
  // identifiers. The old "no control characters" blocklist passed every one of
  // these — which is the argument for the allowlist in one test.
  it("rejects the Unicode esoterica a control-character blocklist misses", () => {
    const RLO = "\u202e"; // bidi right-to-left override — reorders a rendered diff
    const ZWSP = "\u200b"; // zero-width space — invisible in an approval queue
    const NBSP = "\u00a0"; // non-breaking space — not the ASCII space it resembles
    for (const bad of [`re${RLO}cord:`, `re${ZWSP}cord:`, `re${NBSP}cord:`, "record:漢"]) {
      expect(CapabilitiesParse({ data: { sharedReadPrefixes: [bad] } }).success, bad).toBe(false);
    }
  });

  it("rejects control characters — CR/LF here is header/URL-borne injection surface", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    for (const bad of [`re${CR}cord:`, `re${LF}cord:`, `re${NUL}cord:`]) {
      expect(CapabilitiesParse({ data: { sharedWritePrefixes: [bad] } }).success, bad).toBe(false);
    }
  });

  it("caps length at 256 characters — which are bytes, under the ASCII rule", () => {
    expect(CapabilitiesParse({ data: { sharedReadPrefixes: ["a".repeat(256)] } }).success).toBe(
      true,
    );
    expect(CapabilitiesParse({ data: { sharedReadPrefixes: ["a".repeat(257)] } }).success).toBe(
      false,
    );
  });

  it("rejects space-padded and all-space grants — invisible at a diff's edges", () => {
    for (const bad of [" ", "  ", " record:", "record: ", "\trecord:"]) {
      expect(CapabilitiesParse({ data: { sharedWritePrefixes: [bad] } }).success, bad).toBe(false);
    }
    // Interior space is fine — "my records:" is a legal namespace (read array,
    // so no budget refine muddies the assertion).
    expect(CapabilitiesParse({ data: { sharedReadPrefixes: ["my records:"] } }).success).toBe(true);
  });

  it("the literal arrays and collection names carry the same rule — one identifier contract", () => {
    // ADR-0043 tightened these WITH the prefixes, not beside them: every grant
    // string renders in the same approval diff, so they share one character
    // set. Safe in one step because the live databases were swept first (zero
    // non-ASCII keys, grants, or collection names — the ADR's compatibility
    // note records the check).
    expect(CapabilitiesParse({ data: { sharedRead: ["設定"] } }).success).toBe(false);
    expect(CapabilitiesParse({ data: { sharedWrite: ["k\u202e"] } }).success).toBe(false);
    expect(CapabilitiesParse({ data: { collections: ["réponses"] } }).success).toBe(false);
    expect(CapabilitiesParse({ data: { collections: ["signups"] } }).success).toBe(true);
  });

  // Review finding 3: before prefixes, the literal sharedWrite array bounded
  // the rows an app could ever hold. A write PREFIX allows runtime row
  // creation, so the schema couples it to a writesPerDay budget — the grant
  // and its bound are one decision. Read prefixes are exempt (they cannot
  // create rows; listing is page-capped).
  it("requires a writesPerDay budget with shared write prefixes", () => {
    expect(CapabilitiesParse({ data: { sharedWritePrefixes: ["record:"] } }).success).toBe(false);
    expect(
      CapabilitiesParse({ data: { sharedWritePrefixes: ["record:"], writesPerDay: 10_000 } })
        .success,
    ).toBe(true);
  });

  it("read prefixes alone need no budget — they cannot create rows", () => {
    expect(CapabilitiesParse({ data: { sharedReadPrefixes: ["record:"] } }).success).toBe(true);
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

// T-0002 / ADR-0005: the origin's credential select is 3-way (none / stored
// secret / OAuth provider), the shim is a first-class capability with the
// boolean as a normalized legacy alias, and the origin schema is strict.
describe("fetch origin credential exclusivity (spec decision 28)", () => {
  it("rejects an origin declaring both a stored secret and a provider", () => {
    const result = FetchConnectionSchema.safeParse({
      origin: "https://api.vendor.example",
      connection: "vendor-live",
      provider: "vendor",
    });
    expect(result.success).toBe(false);
  });

  it("still parses keyless and secret-bound origins to exactly today's shape", () => {
    // Regression: no deployed app's declaration changes meaning.
    const keyless = FetchConnectionSchema.parse({ origin: "https://api.github.com" });
    expect(keyless).toEqual({ origin: "https://api.github.com" });
    const bound = FetchConnectionSchema.parse({
      origin: "https://api.stripe.com",
      connection: "stripe-live",
    });
    expect(bound).toEqual({ origin: "https://api.stripe.com", connection: "stripe-live" });
  });

  it("parses a provider binding with its required/optional dependency hint", () => {
    const result = AppManifestSchema.safeParse({
      app: "vendor-app",
      visibility: { mode: "internal" },
      capabilities: {
        fetch: {
          origins: [{ origin: "https://app.asana.com", provider: "asana", required: true }],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const bound = result.data.capabilities.fetch?.origins[0];
      expect(bound?.provider).toBe("asana");
      // `required` is the app's dependency hint only — it never blocks app
      // loading or triggers anything platform-side (criterion 17).
      expect(bound?.required).toBe(true);
    }
  });

  it("enforces the provider reference charset on the binding", () => {
    expect(
      FetchConnectionSchema.safeParse({ origin: "https://a.example", provider: "Asana" }).success,
    ).toBe(false);
    expect(
      FetchConnectionSchema.safeParse({ origin: "https://a.example", provider: "" }).success,
    ).toBe(false);
  });

  it("is strict — an unknown origin key is rejected, not stripped (ADR-0005)", () => {
    const result = FetchConnectionSchema.safeParse({
      origin: "https://api.github.com",
      connection: "gh",
      // The silent-strip hazard: today's non-strict schema would drop this and
      // store a binding the author never reviewed.
      credintial: "typo",
    });
    expect(result.success).toBe(false);
  });

  it("strictness does not leak beyond the origin schema", () => {
    // Only the origin schema and the instruction schema went strict; the
    // enclosing blocks keep today's lenient parse.
    expect(CapabilitiesParse({ fetch: { bogus: 1, origins: [] } }).success).toBe(true);
    expect(CapabilitiesParse({ bogus: 1 }).success).toBe(true);
  });
});

describe("first-class shim capability with legacy alias (design decision 6)", () => {
  it("a legacy boolean-shim manifest parses to the same capability set as the new form", () => {
    const legacy = CapabilitiesParse({ fetch: { shim: true } });
    const modern = CapabilitiesParse({ shim: { fetch: true } });
    expect(legacy.success).toBe(true);
    expect(modern.success).toBe(true);
    if (legacy.success && modern.success) {
      // Behaviorally indistinguishable after parse — in fact identical.
      expect(modern.data).toEqual(legacy.data);
      expect(legacy.data.capabilities.fetch?.shim).toBe(true);
      expect(legacy.data.capabilities.shim).toEqual({ fetch: true, connect: false });
    }
  });

  it("keeps the boolean view synchronized on every parse, both directions", () => {
    // Old form → the canonical block appears...
    const legacy = CapabilitiesParse({
      fetch: { shim: true, origins: [{ origin: "https://a.example" }] },
    });
    if (legacy.success) {
      expect(legacy.data.capabilities.fetch?.shim).toBe(true);
      expect(legacy.data.capabilities.shim).toEqual({ fetch: true, connect: false });
    }
    // ...and the new form → the legacy boolean reads the same grant, which is
    // what the edge's per-block fetch parse consumes until the projection
    // migrates (T-0013).
    const modern = CapabilitiesParse({ shim: { fetch: true } });
    if (modern.success) {
      expect(modern.data.capabilities.fetch?.shim).toBe(true);
      expect(modern.data.capabilities.fetch?.origins).toEqual([]);
    }
  });

  it("leaves shim-less manifests without a shim block", () => {
    const parsed = CapabilitiesParse({ fetch: { origins: [{ origin: "https://a.example" }] } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capabilities.shim).toBeUndefined();
      expect(parsed.data.capabilities.fetch?.shim).toBe(false); // today's default
    }
  });

  it("connect is a separate opt-in that never implies the fetch rewrite", () => {
    const parsed = CapabilitiesParse({ shim: { connect: true } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capabilities.shim).toEqual({ fetch: false, connect: true });
      expect(parsed.data.capabilities.fetch).toBeUndefined();
    }
  });

  it("an explicit new-form false beats nothing — the alias only adds a grant", () => {
    // Both spellings present: the merge is ON if either says on (failing here
    // would silently strip a grant written by the pre-T-0002 editor).
    const parsed = CapabilitiesParse({ fetch: { shim: true }, shim: { fetch: false } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capabilities.shim).toEqual({ fetch: true, connect: false });
      expect(parsed.data.capabilities.fetch?.shim).toBe(true);
    }
  });
});
