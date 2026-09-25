import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ConnectionProvider } from "./providers.js";
import {
  ApiOriginSchema,
  CatalogueProviderSchema,
  ConnectionProviderSchema,
  PROVIDER_KINDS,
  ProviderConfigSchema,
  ProviderCreateRequestSchema,
  ProviderExportDocumentSchema,
  ProviderKindSchema,
  ProviderMetadataSchema,
  ProviderRefSchema,
  ProviderUpdateRequestSchema,
  ScopeTokenSchema,
  SENSITIVE_PROVIDER_FIELDS,
  TOKEN_PLACEMENT_KINDS,
  TokenPlacementSchema,
} from "./providers.js";

/** Dev-envelope-shaped sealed material — the row's credential fields never carry plaintext. */
const CLIENT_ID_MATERIAL = "aesgcm:1a2b3c4d:5e6f7081:8292a3b4c5d6e7f8";
const CLIENT_SECRET_MATERIAL = "aesgcm:9a8b7c6d:5e4f3021:1122334455667788";

const CREATE_BODY = {
  ref: "asana",
  displayName: "Asana",
  env: "prod",
  authorizeEndpoint: "https://app.asana.com/-/oauth_authorize",
  tokenEndpoint: "https://app.asana.com/-/oauth_token",
  requestedScopes: ["default", "projects:read"],
  apiOrigins: ["https://app.asana.com"],
  clientId: "1200000000000001",
  clientSecret: "a1b2c3d4e5f6g7h8i9j0",
};

const ROW: ConnectionProvider = {
  id: "0b2f6f8e-4c1a-4d2e-9f3b-2a5c7e9b1d01",
  revision: 3,
  ref: "asana",
  displayName: "Asana",
  kind: "rest-delegated",
  env: "prod",
  authorizeEndpoint: "https://app.asana.com/-/oauth_authorize",
  tokenEndpoint: "https://app.asana.com/-/oauth_token",
  requestedScopes: ["default", "projects:read"],
  apiOrigins: ["https://app.asana.com"],
  tokenPlacement: { kind: "header", name: "x-api-key" },
  clientIdMaterial: CLIENT_ID_MATERIAL,
  clientSecretMaterial: CLIENT_SECRET_MATERIAL,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

/** parse → serialize → parse, with the serialized bytes being what actually travels. */
function roundTrip<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(JSON.parse(JSON.stringify(schema.parse(value))));
}

/**
 * A fixture with keys removed — the "absent" half of every required-field test.
 * The schemas take `unknown`, so the loosened type is the honest input shape.
 */
function withoutKeys(value: object, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

describe("ProviderKindSchema", () => {
  it("parses rest-delegated and nothing else", () => {
    expect(ProviderKindSchema.parse("rest-delegated")).toBe("rest-delegated");
    // Every kind ADR-0031 names that this initiative does not implement, plus
    // the generic fallbacks — none of them is constructible, even by hand (Q21).
    for (const kind of ["mcp-remote", "rest-tenant-key", "basic", "", "REST-DELEGATED"]) {
      expect(ProviderKindSchema.safeParse(kind).success, kind).toBe(false);
    }
  });

  it("stays in step with PROVIDER_KINDS", () => {
    expect(ProviderKindSchema.options).toEqual([...PROVIDER_KINDS]);
  });
});

describe("TokenPlacementSchema", () => {
  it("parses the Bearer default and a named header, normalising its case", () => {
    expect(TokenPlacementSchema.parse({ kind: "header-bearer" })).toEqual({
      kind: "header-bearer",
    });
    expect(TokenPlacementSchema.parse({ kind: "header", name: "X-Api-Key" })).toEqual({
      kind: "header",
      name: "x-api-key",
    });
  });

  // The named-header vendor (Fathom's X-Api-Key shape) is why the named kind
  // exists at all — but it must arrive with its name.
  it("rejects a named header without a name", () => {
    expect(TokenPlacementSchema.safeParse({ kind: "header" }).success).toBe(false);
  });

  // Query-string tokens and signing recipes are refused outright (criterion 4):
  // a delegated user token in a URL lands in vendor and proxy access logs, and
  // a signing recipe is a different credential presentation, not a placement.
  it("refuses a query placement and a signing recipe — the recipe kinds a user token may not use", () => {
    expect(TokenPlacementSchema.safeParse({ kind: "query", param: "access_token" }).success).toBe(
      false,
    );
    expect(
      TokenPlacementSchema.safeParse({
        kind: "hmac-timestamp",
        timestampHeader: "x-date",
        template: "C={credential},S={signature}",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(TokenPlacementSchema.safeParse({ kind: "bearer" }).success).toBe(false);
    expect(TokenPlacementSchema.safeParse({}).success).toBe(false);
  });

  // A recipe pasted into a placement field (its `template`, a `param`) must be
  // refused, not silently stripped to a working-looking placement.
  it("rejects extra keys — a placement is not an injection recipe", () => {
    expect(TokenPlacementSchema.safeParse({ kind: "header-bearer", template: "{}" }).success).toBe(
      false,
    );
    expect(
      TokenPlacementSchema.safeParse({ kind: "header", name: "x-api-key", template: "{}" }).success,
    ).toBe(false);
    expect(
      TokenPlacementSchema.safeParse({ kind: "header", name: "x-api-key", param: "token" }).success,
    ).toBe(false);
  });

  // Same classes the recipe header rule closes: `host` would move TLS SNI off
  // the allowlisted destination, and `x-helix-` is the instruction transport.
  it.each(["host", "content-length", "X-Helix-Method", "host "])(
    "refuses to write the reserved header %s",
    (name) => {
      expect(TokenPlacementSchema.safeParse({ kind: "header", name }).success).toBe(false);
    },
  );

  // The reserved set is only half the shared header-name rule. The charset and
  // length halves keep the name one undici will actually put on the wire, so a
  // name that is not an RFC 7230 token (or over 64 chars) must be a 400 at
  // write time, not a 502 on the first delegated call.
  it("applies the full header-name rule, not just the reserved set", () => {
    expect(TokenPlacementSchema.safeParse({ kind: "header", name: "x api key" }).success).toBe(
      false,
    );
    expect(TokenPlacementSchema.safeParse({ kind: "header", name: "x".repeat(65) }).success).toBe(
      false,
    );
  });

  it("stays in step with TOKEN_PLACEMENT_KINDS (which drives the UI select order)", () => {
    expect(TokenPlacementSchema.options.map((o) => o.shape.kind.value)).toEqual([
      ...TOKEN_PLACEMENT_KINDS,
    ]);
  });

  it("defaults to the Bearer header when omitted", () => {
    const parsed = ProviderCreateRequestSchema.parse(CREATE_BODY);
    expect(parsed.tokenPlacement).toEqual({ kind: "header-bearer" });
  });
});

describe("ScopeTokenSchema", () => {
  it("accepts ordinary vendor scopes", () => {
    for (const scope of ["default", "projects:read", "https://api.example.com/scope"]) {
      expect(ScopeTokenSchema.parse(scope)).toBe(scope);
    }
  });

  // Scopes join with spaces on the wire, so a scope containing one is
  // indistinguishable from two; CR/LF travels into the authorize URL the
  // platform builds from this list. RFC 6749 excludes space, quote, backslash.
  it("refuses a space, a quote, a backslash, and control characters", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    for (const bad of ["projects read", 'a"b', "a\\b", `a${CR}b`, `a${LF}b`, "", "読む"]) {
      expect(ScopeTokenSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("bounds a scope at 256 characters", () => {
    expect(ScopeTokenSchema.safeParse("a".repeat(256)).success).toBe(true);
    expect(ScopeTokenSchema.safeParse("a".repeat(257)).success).toBe(false);
  });

  it("rejects duplicate requested scopes", () => {
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        requestedScopes: ["default", "default"],
      }).success,
    ).toBe(false);
  });

  // A provider that requests nothing is legitimate (vendors exist whose tokens
  // carry no scope), and "empty" must stay representable rather than failing
  // every read of such a row.
  it("allows an empty requested-scope list", () => {
    const parsed = ProviderCreateRequestSchema.parse({ ...CREATE_BODY, requestedScopes: [] });
    expect(parsed.requestedScopes).toEqual([]);
  });

  // The scope rule's default lives here and on the export document, not on
  // the rule: a hand-written configuration legitimately says nothing about
  // scopes, and the update request requires the field — default-ness is
  // applied at the consumer. This pin is what keeps a future "harmonize"
  // edit from silently breaking scopeless creates.
  it("defaults an omitted scope list to empty on create", () => {
    const parsed = ProviderCreateRequestSchema.parse(withoutKeys(CREATE_BODY, "requestedScopes"));
    expect(parsed.requestedScopes).toEqual([]);
  });
});

describe("ApiOriginSchema", () => {
  it("canonicalises bare-origin spellings to the origin", () => {
    for (const [input, canonical] of [
      ["https://app.asana.com", "https://app.asana.com"],
      ["https://app.asana.com/", "https://app.asana.com"],
      ["https://app.asana.com:443", "https://app.asana.com"],
      ["http://localhost:8123", "http://localhost:8123"],
    ] as const) {
      expect(ApiOriginSchema.parse(input)).toBe(canonical);
    }
  });

  // The raw-input guard is case-insensitive by its `i` flag — one droppable
  // token. Without it an uppercase scheme or host is refused at the textual
  // layer, before the parser ever gets the chance to lowercase the origin.
  it("canonicalises case-variant hosts and schemes to the lowercase origin", () => {
    expect(ApiOriginSchema.parse("https://APP.ASANA.COM")).toBe("https://app.asana.com");
    expect(ApiOriginSchema.parse("HTTPS://app.asana.com")).toBe("https://app.asana.com");
  });

  // The origin schema reads the string the URL parser reads. Zod's url check
  // trims outer whitespace and rewrites the value before these guards run,
  // and the parser itself removes TAB/LF/CR from anywhere in its input — so
  // both spellings canonicalise to the parser's own reading, the same string
  // the manifest side's `new URL(origin).origin` produces, keeping the
  // binding comparison canonical-to-canonical on both sides. The line is
  // drawn at literal path syntax: a `/` or `?` survives the parser's removal,
  // so the raw-input guard still sees and refuses it.
  it("canonicalises outer whitespace and interior controls to the parser's reading, and refuses literal path syntax", () => {
    expect(ApiOriginSchema.parse(" https://app.asana.com")).toBe("https://app.asana.com");
    expect(ApiOriginSchema.parse("https://app.asana.com ")).toBe("https://app.asana.com");
    // TAB is in the parser's removal set: with no literal delimiter in the
    // raw string the whole span is one authority, and the parser's reading of
    // it — not the raw spelling — is what gets stored.
    expect(ApiOriginSchema.parse("https://api\ta.example.com")).toBe("https://apia.example.com");
    expect(ApiOriginSchema.parse("https://api.example.com\tpath")).toBe(
      "https://api.example.compath",
    );
    expect(ApiOriginSchema.safeParse("https://host\t/path").success).toBe(false);
    expect(ApiOriginSchema.safeParse("https://host\t?").success).toBe(false);
  });

  // A path is rejected rather than normalised off: silently storing the origin
  // of `https://vendor.example/api` would keep a destination the administrator
  // never described, and the diff the confirmation panel shows would lie.
  it("rejects a path, a query, a fragment, and userinfo — loudly, not by dropping them", () => {
    for (const bad of [
      "https://app.asana.com/api",
      "https://app.asana.com/?a=1",
      "https://app.asana.com#token",
      "https://user:pass@app.asana.com",
    ]) {
      expect(ApiOriginSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  // A bare `?` or `#` parses to an empty search/hash, so the structural
  // backstop on the parsed value is blind to it — the raw guard is the only
  // layer that refuses those. `//` is a path (the guard allows at most one
  // trailing slash), and `\` is a path separator in special-scheme URLs.
  it("rejects path spellings only the raw-input guard can see", () => {
    for (const bad of [
      "https://app.asana.com//",
      "https://app.asana.com\\private",
      "https://app.asana.com?",
      "https://app.asana.com#",
    ]) {
      expect(ApiOriginSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  // The guard's authority charset excludes delimiters (`/ ? # @ \`), not
  // characters: brackets and colons are a legal authority, so an IPv6
  // destination must keep parsing rather than falling to a hostname
  // allowlist the guard never promised.
  it("accepts a bracketed IPv6 authority", () => {
    expect(ApiOriginSchema.parse("http://[::1]:8123")).toBe("http://[::1]:8123");
  });

  // Egress speaks http(s) only; anything else is a misconfiguration worth a
  // write-time error rather than a 502 on the first delegated call.
  it("refuses non-http(s) schemes", () => {
    for (const bad of ["ftp://files.example.com", "ws://api.example.com"]) {
      expect(ApiOriginSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("rejects duplicate destinations, including two spellings of one origin", () => {
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        apiOrigins: ["https://app.asana.com", "https://app.asana.com"],
      }).success,
    ).toBe(false);
    // The dedupe sees the canonical form: a trailing slash is the same origin.
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        apiOrigins: ["https://app.asana.com", "https://app.asana.com/"],
      }).success,
    ).toBe(false);
  });

  // A provider with no destination can never be bound by any manifest — a
  // dead configuration, refused at write time.
  it("requires at least one API destination", () => {
    expect(ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, apiOrigins: [] }).success).toBe(
      false,
    );
    expect(
      ProviderCreateRequestSchema.safeParse(withoutKeys(CREATE_BODY, "apiOrigins")).success,
    ).toBe(false);
  });
});

describe("ProviderRefSchema", () => {
  it("accepts the secret-name convention and refuses everything else", () => {
    expect(ProviderRefSchema.parse("asana")).toBe("asana");
    for (const bad of ["Asana", "asana live", "asana_live", "-asana", "", "a".repeat(65)]) {
      expect(ProviderRefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("ProviderCreateRequestSchema", () => {
  it("parses a full create, defaulting kind and placement, and keeping env explicit", () => {
    const parsed = ProviderCreateRequestSchema.parse(CREATE_BODY);
    expect(parsed).toEqual({
      ref: "asana",
      displayName: "Asana",
      kind: "rest-delegated",
      env: "prod",
      authorizeEndpoint: "https://app.asana.com/-/oauth_authorize",
      tokenEndpoint: "https://app.asana.com/-/oauth_token",
      requestedScopes: ["default", "projects:read"],
      apiOrigins: ["https://app.asana.com"],
      tokenPlacement: { kind: "header-bearer" },
      clientId: "1200000000000001",
      clientSecret: "a1b2c3d4e5f6g7h8i9j0",
    });
  });

  // env selects the partition the whole vendor registration lives in and is
  // immutable after create — a silent default would put registrations in the
  // wrong tier (criterion 5). The administrator chooses it every time.
  it("requires the environment — there is no default tier", () => {
    expect(ProviderCreateRequestSchema.safeParse(withoutKeys(CREATE_BODY, "env")).success).toBe(
      false,
    );
  });

  // The dev partition is a first-class tier a registration can live in, and a
  // value outside the two is refused: env is a partition dimension on the
  // metering ledger and every app-data table, never a free-form label, so a
  // typo'd tier must fail at the parse rather than partition the registration
  // into a tier nothing reads.
  it("accepts a dev-tier registration and refuses an environment outside the two tiers", () => {
    expect(ProviderCreateRequestSchema.parse({ ...CREATE_BODY, env: "dev" }).env).toBe("dev");
    expect(ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, env: "staging" }).success).toBe(
      false,
    );
  });

  // The only place the vendor registration crosses the boundary in plaintext.
  // Both halves are required: a provider that cannot authenticate to its
  // vendor is dead configuration.
  it("requires both halves of the client registration", () => {
    expect(
      ProviderCreateRequestSchema.safeParse(withoutKeys(CREATE_BODY, "clientId")).success,
    ).toBe(false);
    expect(
      ProviderCreateRequestSchema.safeParse(withoutKeys(CREATE_BODY, "clientSecret")).success,
    ).toBe(false);
  });

  // A create body is a hand-written document, so an absent field is malformed
  // input, not a value to default or manufacture: env, the credentials, and
  // the destination list carry their own absence pins, and these four
  // complete the set. The three editable fields are one declaration shared by
  // every composer, and `ref` keys the export document — a defaulted or
  // optional field among them would flow into the update request, the stored
  // row, and every export, substituting state no administrator sent.
  it.each(["ref", "displayName", "authorizeEndpoint", "tokenEndpoint"])(
    "refuses a create body missing %s — configuration is required, not defaulted",
    (field) => {
      expect(ProviderCreateRequestSchema.safeParse(withoutKeys(CREATE_BODY, field)).success).toBe(
        false,
      );
    },
  );

  // A typo'd field name (`authoriseEndpoint`) under a stripping schema would
  // apply a different provider than the one the administrator reviewed. The
  // strict parse is the fail-closed half of that hazard.
  it("rejects unknown keys rather than silently dropping them", () => {
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, authoriseEndpoint: "https://x" })
        .success,
    ).toBe(false);
  });

  it("rejects an unimplemented kind", () => {
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, kind: "mcp-remote" }).success,
    ).toBe(false);
  });

  // Egress speaks http(s) only, and these are the URLs the platform builds
  // authorize redirects and token POSTs against — a non-http(s) endpoint is
  // the same write-time misconfiguration the origin rule refuses.
  it("refuses non-http(s) OAuth endpoints", () => {
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        authorizeEndpoint: "ftp://app.asana.com/-/oauth_authorize",
      }).success,
    ).toBe(false);
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        tokenEndpoint: "ws://app.asana.com/-/oauth_token",
      }).success,
    ).toBe(false);
  });

  // Userinfo is refused as *syntax*, not only when it carries a non-empty
  // credential: the URL parser renders `:@` empty (username and password both
  // ""), so a content check would pass it while the docblock says "no
  // userinfo". An `@` inside a query value stays legitimate — client auth is
  // never configured in the URL, but query parameters are.
  it("refuses userinfo in OAuth endpoints even when it is empty", () => {
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        authorizeEndpoint: "https://:@app.asana.com/-/oauth_authorize",
      }).success,
    ).toBe(false);
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        tokenEndpoint: "https://:@app.asana.com/-/oauth_token",
      }).success,
    ).toBe(false);
    // …and an @ in a query value is not userinfo.
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        tokenEndpoint: "https://app.asana.com/-/oauth_token?redirect=a@b",
      }).success,
    ).toBe(true);
  });

  // The scheme half of the userinfo guard is hand-rolled case classes, not an
  // `i` flag — beside the origin guard's `/i` idiom they look redundant, and
  // simplifying them to `^https?:` would silently admit an uppercase-scheme
  // credential URL: the parser lowercases the scheme, the protocol check
  // passes, and nothing else inspects userinfo. The refusal must hold for
  // every casing the parser accepts.
  it("refuses userinfo in OAuth endpoints regardless of scheme casing", () => {
    for (const field of ["authorizeEndpoint", "tokenEndpoint"]) {
      expect(
        ProviderCreateRequestSchema.safeParse({
          ...CREATE_BODY,
          [field]: "HTTPS://client:secret@auth.vendor.example/oauth",
        }).success,
        field,
      ).toBe(false);
    }
  });

  // The guard's authority class ends at `/` and excludes `\`, so an `@`
  // beyond either boundary is not userinfo: in a path it is a literal
  // character, and after a backslash the parser has already left the
  // authority (special schemes treat `\` as a separator — host `user`, path
  // `/pass@…`, no credentials anywhere). Re-broadening the class — even back
  // to its pre-fix `[^/?#]*` form — would refuse these credential-free
  // endpoints.
  it("keeps non-userinfo @ spellings legitimate — in a path or after a backslash", () => {
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        authorizeEndpoint: "https://auth.vendor.example/oauth@version",
      }).success,
    ).toBe(true);
    expect(
      ProviderCreateRequestSchema.safeParse({
        ...CREATE_BODY,
        tokenEndpoint: "https://user\\pass@auth.vendor.example/oauth",
      }).success,
    ).toBe(true);
  });

  // The separator skip covers `\` as well as `/`: the parser's
  // special-authority state ignores either after the scheme separator, so
  // `https://\user:pass@host` carries full userinfo past a literal `://`
  // that zod's own URL check accepts. Narrowing the skip to slashes alone
  // reopens the credential-export hole — and the all-backslash adversarial
  // spelling never reaches this guard (zod requires the literal `://`
  // upstream), so this is the only pin for the backslash half.
  it("refuses userinfo after a backslash separator", () => {
    for (const field of ["authorizeEndpoint", "tokenEndpoint"]) {
      expect(
        ProviderCreateRequestSchema.safeParse({
          ...CREATE_BODY,
          [field]: "https://\\client:secret@auth.vendor.example/oauth",
        }).success,
        field,
      ).toBe(false);
    }
  });

  // A leading C0 control (not whitespace — JS trim, and therefore zod's,
  // leaves it) hides the scheme from zod's literal `://` prefix check even
  // though the URL parser itself would strip the control and parse with
  // userinfo. Today the overall parse fails on that prefix check; this pin
  // holds the line behaviorally, so a future change that widens the prefix
  // check toward the parser cannot silently start accepting credentials.
  it("refuses an endpoint whose leading C0 control hides the scheme prefix", () => {
    for (const field of ["authorizeEndpoint", "tokenEndpoint"]) {
      expect(
        ProviderCreateRequestSchema.safeParse({
          ...CREATE_BODY,
          [field]: "\x00https://client:secret@auth.vendor.example/oauth",
        }).success,
        field,
      ).toBe(false);
      expect(
        ProviderCreateRequestSchema.safeParse({
          ...CREATE_BODY,
          [field]: "\x0bhttps://client:secret@auth.vendor.example/oauth",
        }).success,
        field,
      ).toBe(false);
    }
  });

  // An empty client id or secret is a provider that cannot authenticate to
  // its vendor — dead configuration, refused like an absent one.
  it("refuses an empty client id or secret", () => {
    expect(ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, clientId: "" }).success).toBe(
      false,
    );
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, clientSecret: "" }).success,
    ).toBe(false);
  });

  it("refuses a blank or over-long display name", () => {
    expect(ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, displayName: "" }).success).toBe(
      false,
    );
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, displayName: "x".repeat(201) })
        .success,
    ).toBe(false);
  });

  // The array bounds are sanity rails on admin input, not security limits —
  // the same class as the scope-token length bound. Pinning both sides
  // documents where each rail sits, so a revision is a visible, deliberate
  // edit rather than silent drift.
  it("bounds the API-destination and scope lists", () => {
    const origins = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://v${i + 1}.example.com`);
    const scopes = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, apiOrigins: origins(16) }).success,
    ).toBe(true);
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, apiOrigins: origins(17) }).success,
    ).toBe(false);
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, requestedScopes: scopes(32) })
        .success,
    ).toBe(true);
    expect(
      ProviderCreateRequestSchema.safeParse({ ...CREATE_BODY, requestedScopes: scopes(33) })
        .success,
    ).toBe(false);
  });

  // The pass side of every bounded string, the way the array and scope bounds
  // above pin both sides: a fail-side pin alone cannot tell a deliberate rail
  // from an over-tightened one, and a 64-character ref or header name or a
  // 200-character display name is a legitimate vendor registration — refusing
  // it at write time is a regression, not a rail.
  it("accepts the longest legitimate value on every bounded string field", () => {
    const parsed = ProviderCreateRequestSchema.parse({
      ...CREATE_BODY,
      ref: "a".repeat(64),
      displayName: "x".repeat(200),
      tokenPlacement: { kind: "header", name: "n".repeat(64) },
    });
    expect(parsed.ref).toHaveLength(64);
    expect(parsed.displayName).toHaveLength(200);
    expect(parsed.tokenPlacement).toEqual({ kind: "header", name: "n".repeat(64) });
  });
});

describe("ProviderUpdateRequestSchema", () => {
  it("parses a full-replace edit with the revision, keeping credentials optional", () => {
    const parsed = ProviderUpdateRequestSchema.parse({
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
      revision: 3,
    });
    expect(parsed.revision).toBe(3);
    // Absent credential fields mean "keep" — they are simply not on the edit.
    expect(parsed).not.toHaveProperty("clientId");
    expect(parsed).not.toHaveProperty("clientSecret");
  });

  it("rejects an edit without a revision — the optimistic lock is not optional", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: [],
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: { kind: "header-bearer" },
      revision: 1,
    };
    expect(ProviderUpdateRequestSchema.safeParse(withoutKeys(base, "revision")).success).toBe(
      false,
    );
  });

  // ref and env are immutable after create (criterion 5) and kind never
  // changes: under a stripping schema these would be silently ignored, and a
  // client could believe it had moved a provider between environments.
  it("refuses an attempt to change ref, env, or kind through the body", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: { kind: "header-bearer" },
      revision: 3,
    };
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, ref: "asana-prod" }).success).toBe(
      false,
    );
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, env: "dev" }).success).toBe(false);
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, kind: "rest-delegated" }).success).toBe(
      false,
    );
  });

  // Client-identity change is detected by *presence* in the request, so an
  // empty or null credential is neither "keep" (that is absent) nor a usable
  // change — if it parsed, presence-detection would read it as a rotation or
  // identity change and the portal would seal empty material onto the row.
  it("refuses an empty or null credential where presence means a change", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
      revision: 3,
    };
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, clientId: "" }).success).toBe(false);
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, clientId: null }).success).toBe(false);
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, clientSecret: "" }).success).toBe(
      false,
    );
  });

  // JSON cannot write an undefined-valued key — serialization drops the
  // value — but a typed caller spreading an optional form value constructs
  // exactly that. The parse treats it as the absence it serializes to: the
  // credential keys come out absent, so presence keeps one meaning — a value
  // was supplied, the signal client-identity detection runs on — and an
  // undefined-valued required field is a missing field, not a silent accept.
  it("treats a key present with value undefined as absent — one spelling of absence", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
      revision: 3,
    };
    const parsed = ProviderUpdateRequestSchema.parse({
      ...base,
      clientId: undefined,
      clientSecret: undefined,
    });
    expect(parsed).not.toHaveProperty("clientId");
    expect(parsed).not.toHaveProperty("clientSecret");
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, displayName: undefined }).success).toBe(
      false,
    );
  });

  // The drop rule runs over the body's keys generically, not over a list of
  // known optional fields: an undefined-valued key is absence whatever its
  // name, while the same key carrying a value stays an unknown key the strict
  // parse rejects. A future optional field with presence semantics inherits
  // the rule by construction; narrowing it to a per-field delete would make
  // "not supplied" mean different things on different keys of one body.
  it("drops any undefined-valued key — the absence rule is generic over the body's keys", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
      revision: 3,
    };
    const withUnsupplied = ProviderUpdateRequestSchema.parse({
      ...base,
      futureField: undefined,
    });
    expect(withUnsupplied).not.toHaveProperty("futureField");
    expect(ProviderUpdateRequestSchema.safeParse({ ...base, futureField: "x" }).success).toBe(
      false,
    );
  });

  // The preprocess runs before zod's own type checks, and zod does not catch
  // exceptions from preprocess functions: without the typeof guard in the
  // normaliser, Object.entries(null) throws and the TypeError escapes
  // safeParse — a route's input-rejection path would become its
  // unexpected-error path. Every non-object spelling must fail as a value.
  it("returns a validation failure, never an exception, for a non-object body", () => {
    for (const body of [null, undefined, 42, "body", true, [], ["x"]]) {
      expect(ProviderUpdateRequestSchema.safeParse(body).success, String(body)).toBe(false);
    }
  });

  // `__proto__` gets no special spelling of its own: it is an unknown key,
  // and unknown keys have one rule — a value refuses the body, an undefined
  // value is absence. Zod's own unrecognized-key walk steps over `__proto__`
  // (its result object is built by assignment, so the key must not reach
  // it), and JSON can carry it as an own property, so the refusal is the
  // schema's to make — on the input, where the key is still visible. A null
  // value is a value: JSON writes it, and the body is refused like any
  // other unknown-key spelling.
  it("refuses an own __proto__ key whatever its value, and treats an undefined one as absence", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
      revision: 3,
    };
    for (const protoValue of [null, { clientId: "synthetic-credential" }, "x"]) {
      const body: unknown = JSON.parse(JSON.stringify({ ...base, ["__proto__"]: protoValue }));
      expect(ProviderUpdateRequestSchema.safeParse(body).success, String(protoValue)).toBe(false);
    }
    // The undefined spelling is the typed caller's — JSON cannot write it
    // (serialization drops it), so this half stays an in-process object.
    const parsed = ProviderUpdateRequestSchema.parse({ ...base, ["__proto__"]: undefined });
    expect(parsed).not.toHaveProperty("__proto__");
  });

  // A full-replace edit carries every editable field; the schema must not
  // materialize a sensitive change out of an omitted one. Absence must be a
  // parse failure, the way it is for displayName and the endpoints — not a
  // default: `requestedScopes` omitted currently parses as "clear every
  // scope" and `tokenPlacement` omitted as "reset to Bearer", and both are
  // sensitive edits (SENSITIVE_PROVIDER_FIELDS) that invalidate connections
  // and demand the criterion-7 confirmation — for a change the administrator
  // never made. The create and import paths keep their defaults; the update
  // body is where absence has existing state to destroy.
  it("refuses a partial edit body — absence is not a clear or a reset", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
      revision: 3,
    };
    expect(
      ProviderUpdateRequestSchema.safeParse(withoutKeys(base, "requestedScopes")).success,
    ).toBe(false);
    expect(ProviderUpdateRequestSchema.safeParse(withoutKeys(base, "tokenPlacement")).success).toBe(
      false,
    );
  });

  // The complement of the absence pin above: an explicit empty list is a
  // deliberate clear — a sensitive edit the criterion-7 confirmation covers —
  // and must stay expressible. Required-ness must not over-correct into
  // non-empty.
  it("parses an explicit empty scope list — a deliberate clear is expressible", () => {
    const parsed = ProviderUpdateRequestSchema.parse({
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: [],
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
      revision: 3,
    });
    expect(parsed.requestedScopes).toEqual([]);
  });

  // Revision starts at 1 and only advances (ADR-0004) — zero, negative, and
  // fractional values are malformed, not edge cases to tolerate: the
  // optimistic lock and the invalidation transaction both key off this field.
  it("refuses a revision below 1 or a non-integer", () => {
    const base = {
      displayName: "Asana",
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: [],
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: { kind: "header-bearer" },
      revision: 1,
    };
    for (const revision of [0, -1, 1.5]) {
      expect(
        ProviderUpdateRequestSchema.safeParse({ ...base, revision }).success,
        String(revision),
      ).toBe(false);
    }
  });
});

describe("ConnectionProviderSchema", () => {
  it("round-trips a fully-configured row through serialize and back, unchanged", () => {
    expect(roundTrip(ConnectionProviderSchema, ROW)).toEqual(ROW);
  });

  it("rejects unknown keys on the row", () => {
    expect(ConnectionProviderSchema.safeParse({ ...ROW, extra: 1 }).success).toBe(false);
  });

  it("requires both sealed credential materials", () => {
    expect(ConnectionProviderSchema.safeParse(withoutKeys(ROW, "clientIdMaterial")).success).toBe(
      false,
    );
    expect(
      ConnectionProviderSchema.safeParse(withoutKeys(ROW, "clientSecretMaterial")).success,
    ).toBe(false);
  });

  // An empty material is not a sealed anything — the writer path (seal at
  // create/rotate) cannot produce it, so a row carrying one is a defect worth
  // an unreadable-row error, not a value egress should have to open and fail
  // on at call time.
  it("refuses an empty sealed material", () => {
    expect(ConnectionProviderSchema.safeParse({ ...ROW, clientIdMaterial: "" }).success).toBe(
      false,
    );
    expect(ConnectionProviderSchema.safeParse({ ...ROW, clientSecretMaterial: "" }).success).toBe(
      false,
    );
  });

  // Same rule as the edit request's revision — the two declarations are
  // independent, so both carry the boundary. Revision starts at 1 and serves
  // admin concurrency, cache invalidation, and consent staleness (ADR-0004);
  // a row at 0 or a half-step has no meaning in any of those roles.
  it("refuses a revision below 1 or a non-integer", () => {
    for (const revision of [0, -1, 1.5]) {
      expect(
        ConnectionProviderSchema.safeParse({ ...ROW, revision }).success,
        String(revision),
      ).toBe(false);
    }
  });

  // The row's identity and ledger columns are as load-bearing as its revision:
  // egress reads the row through its revision-keyed cache and both planes
  // agree the row shape, so a row whose id is not a UUID or whose timestamps
  // are not ISO is a corrupt row object, refused at the parse instead of
  // flowing into a cache key or an ORDER BY. The space-separated and offset
  // timestamp spellings are refused too — the row speaks UTC `Z` form only.
  it("refuses a malformed row identity or timestamp", () => {
    expect(ConnectionProviderSchema.safeParse({ ...ROW, id: "not-a-uuid" }).success).toBe(false);
    for (const bad of [
      "2026-09-25 00:00:00Z",
      "2026-09-25",
      "2026-09-25T00:00:00+02:00",
      1758000000000,
    ]) {
      expect(
        ConnectionProviderSchema.safeParse({ ...ROW, createdAt: bad }).success,
        String(bad),
      ).toBe(false);
      expect(
        ConnectionProviderSchema.safeParse({ ...ROW, updatedAt: bad }).success,
        String(bad),
      ).toBe(false);
    }
  });

  // A stored row is a complete record, not a form. The editable base's
  // `.default()`s exist for create and import documents — hand-written shapes
  // where omission is a legitimate choice — and the update request re-declares
  // both fields required precisely because a default there manufactured a
  // sensitive edit out of an omitted one. The row composes the same base and
  // thereby inherits the same defaults: a row object missing its placement
  // parses as Bearer and one missing its scopes as scopeless, substituting
  // state nobody wrote. No legitimate writer can produce such a row (create's
  // defaults fire into the stored values; an edit carries both fields), so the
  // only producer is a bug — a partial SELECT, a projection that drops a
  // column, a cache deserialization — and the parse's job is to surface that,
  // not repair it. ProviderMetadataSchema, the read-side projection management
  // reads validate through, inherits the same fabrication by omitting the
  // credential fields of this schema.
  it("refuses a row that lost its placement or scopes — a stored row is complete, not defaulted", () => {
    expect(ConnectionProviderSchema.safeParse(withoutKeys(ROW, "tokenPlacement")).success).toBe(
      false,
    );
    expect(ConnectionProviderSchema.safeParse(withoutKeys(ROW, "requestedScopes")).success).toBe(
      false,
    );
  });
});

describe("ProviderMetadataSchema", () => {
  // The read-side projection of a row: the credential fields removed before
  // the value reaches any response, the way the portal's read route builds it.
  const readableRow = withoutKeys(ROW, "clientIdMaterial", "clientSecretMaterial");

  it("is the row with the credential fields absent, not merely empty", () => {
    const keys = Object.keys(ProviderMetadataSchema.parse(readableRow)).sort();
    expect(keys).toEqual([
      "apiOrigins",
      "authorizeEndpoint",
      "createdAt",
      "displayName",
      "env",
      "id",
      "kind",
      "ref",
      "requestedScopes",
      "revision",
      "tokenEndpoint",
      "tokenPlacement",
      "updatedAt",
    ]);
    expect(keys).not.toContain("clientIdMaterial");
    expect(keys).not.toContain("clientSecretMaterial");
  });

  // A read surface is as complete as the row it mirrors: the bug class that
  // produces an absent-key record (a partial SELECT, a projection that drops
  // a column, a cache deserialization) surfaces on the read path, which
  // validates through this schema. Its strictness is inherited from the row
  // via .omit composition rather than declared here — a hand-rolled rebuild
  // of this shape could reintroduce defaulted or optional fields while the
  // row's own pin stays green, so completeness is pinned on this surface too.
  it("refuses a read response that lost its placement or scopes — the read surface is complete, not defaulted", () => {
    expect(
      ProviderMetadataSchema.safeParse(withoutKeys(readableRow, "tokenPlacement")).success,
    ).toBe(false);
    expect(
      ProviderMetadataSchema.safeParse(withoutKeys(readableRow, "requestedScopes")).success,
    ).toBe(false);
  });

  // The leak detector: a route that spreads a row into its read response fails
  // to parse here, instead of the schema silently stripping the credential
  // fields out of a payload that actually carried them.
  it("refuses to parse a whole row spread into a read response", () => {
    expect(ProviderMetadataSchema.safeParse(ROW).success).toBe(false);
  });
});

describe("ProviderConfigSchema", () => {
  it("carries exactly the exportable configuration — no credential and no environment", () => {
    const config = ProviderConfigSchema.parse({
      ref: ROW.ref,
      displayName: ROW.displayName,
      kind: ROW.kind,
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
    });
    expect(Object.keys(config).sort()).toEqual([
      "apiOrigins",
      "authorizeEndpoint",
      "displayName",
      "kind",
      "ref",
      "requestedScopes",
      "tokenEndpoint",
      "tokenPlacement",
    ]);
  });
});

describe("ProviderExportDocumentSchema", () => {
  it("round-trips an export through serialize and back without changing its meaning", () => {
    const document = {
      version: 1,
      provider: {
        ref: ROW.ref,
        displayName: ROW.displayName,
        kind: ROW.kind,
        authorizeEndpoint: ROW.authorizeEndpoint,
        tokenEndpoint: ROW.tokenEndpoint,
        requestedScopes: ROW.requestedScopes,
        apiOrigins: ROW.apiOrigins,
        tokenPlacement: ROW.tokenPlacement,
      },
    };
    expect(roundTrip(ProviderExportDocumentSchema, document)).toEqual(
      ProviderExportDocumentSchema.parse(document),
    );
  });

  // Unnormalized spellings canonicalise on the way in, so the same document
  // re-exported and re-imported proposes a no-op diff, not a churn diff.
  it("round-trips normalised values stably", () => {
    const document = {
      version: 1,
      provider: {
        ref: "fathom",
        displayName: "Fathom",
        kind: "rest-delegated",
        authorizeEndpoint: "https://api.fathom.example/authorize",
        tokenEndpoint: "https://api.fathom.example/token",
        requestedScopes: ["read"],
        apiOrigins: ["https://api.fathom.example/"],
        tokenPlacement: { kind: "header", name: "X-Api-Key" },
      },
    };
    const parsed = ProviderExportDocumentSchema.parse(document);
    expect(parsed.provider.apiOrigins).toEqual(["https://api.fathom.example"]);
    expect(parsed.provider.tokenPlacement).toEqual({ kind: "header", name: "x-api-key" });
    expect(roundTrip(ProviderExportDocumentSchema, parsed)).toEqual(parsed);
  });

  // The provable shape property (criterion 11): the serialized document
  // enumerates exactly {version, provider} over exactly the eight
  // credential-free fields. Any field added later moves this assertion, so a
  // credential or environment key cannot appear unnoticed.
  it("serializes to exactly the two document keys over the eight provider fields", () => {
    const serialized = ProviderExportDocumentSchema.parse({
      version: 1,
      provider: {
        ref: ROW.ref,
        displayName: ROW.displayName,
        kind: ROW.kind,
        authorizeEndpoint: ROW.authorizeEndpoint,
        tokenEndpoint: ROW.tokenEndpoint,
        requestedScopes: ROW.requestedScopes,
        apiOrigins: ROW.apiOrigins,
        tokenPlacement: ROW.tokenPlacement,
      },
    });
    expect(Object.keys(serialized).sort()).toEqual(["provider", "version"]);
    expect(Object.keys(serialized.provider).sort()).toEqual([
      "apiOrigins",
      "authorizeEndpoint",
      "displayName",
      "kind",
      "ref",
      "requestedScopes",
      "tokenEndpoint",
      "tokenPlacement",
    ]);
  });

  it("refuses a document that smuggles credentials or an environment in", () => {
    const provider = {
      ref: ROW.ref,
      displayName: ROW.displayName,
      kind: ROW.kind,
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
    };
    for (const smuggled of [
      { clientId: "1200000000000001" },
      { clientSecret: "a1b2c3d4e5f6g7h8i9j0" },
      { clientIdMaterial: CLIENT_ID_MATERIAL },
      { clientSecretMaterial: CLIENT_SECRET_MATERIAL },
      { env: "prod" },
      { secretRef: "some-vault-reference" },
    ]) {
      const result = ProviderExportDocumentSchema.safeParse({
        version: 1,
        provider: { ...provider, ...smuggled },
      });
      expect(result.success, Object.keys(smuggled)[0]).toBe(false);
    }
  });

  // A version this code does not understand fails closed — a future export
  // format is a new literal and a new parser, not silently-dropped fields.
  it("refuses an unknown document version", () => {
    const provider = {
      ref: ROW.ref,
      displayName: ROW.displayName,
      kind: ROW.kind,
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
    };
    expect(ProviderExportDocumentSchema.safeParse({ version: 2, provider }).success).toBe(false);
    expect(ProviderExportDocumentSchema.safeParse({ provider }).success).toBe(false);
  });

  // The literal's type is half of the gate: a hand-rolled producer writing
  // `"version": "1"` is the most likely spelling of a document this code
  // cannot vouch for, and coercing it would accept an export nobody
  // serialized through the schema. The number-literal parse refuses the
  // string form by type, not just by value.
  it("refuses a document version spelled as a string", () => {
    const provider = {
      ref: ROW.ref,
      displayName: ROW.displayName,
      kind: ROW.kind,
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
    };
    expect(ProviderExportDocumentSchema.safeParse({ version: "1", provider }).success).toBe(false);
  });

  // The wrapper is strict like everything else in the file: a hand-edited
  // document carrying an extra key is refused whole, not imported with the
  // unknown silently trimmed away — the fail-closed half of "a future format
  // is a new literal and a new parser".
  it("refuses unknown keys on the document wrapper", () => {
    const provider = {
      ref: ROW.ref,
      displayName: ROW.displayName,
      kind: ROW.kind,
      authorizeEndpoint: ROW.authorizeEndpoint,
      tokenEndpoint: ROW.tokenEndpoint,
      requestedScopes: ROW.requestedScopes,
      apiOrigins: ROW.apiOrigins,
      tokenPlacement: ROW.tokenPlacement,
    };
    expect(
      ProviderExportDocumentSchema.safeParse({
        version: 1,
        provider,
        exportedBy: "alice@example.com",
      }).success,
    ).toBe(false);
  });
});

describe("CatalogueProviderSchema", () => {
  it("exposes discovery metadata only — no endpoints, no credentials", () => {
    const entry = CatalogueProviderSchema.parse({
      ref: "asana",
      kind: "rest-delegated",
      displayName: "Asana",
      apiOrigins: ["https://app.asana.com"],
      env: "prod",
    });
    expect(Object.keys(entry).sort()).toEqual(["apiOrigins", "displayName", "env", "kind", "ref"]);
    expect(CatalogueProviderSchema.safeParse({ ...entry, clientSecret: "x" }).success).toBe(false);
    expect(
      CatalogueProviderSchema.safeParse({ ...entry, tokenEndpoint: "https://x" }).success,
    ).toBe(false);
  });

  // The entry shares the row's destination rule rather than a looser restatement:
  // a producer bug that emitted a destination-less (or duplicated) entry fails
  // loudly here instead of reaching the SPA.
  it("carries the row's destination rule — at least one, no duplicates", () => {
    const base = {
      ref: "asana",
      kind: "rest-delegated" as const,
      displayName: "Asana",
      env: "prod" as const,
    };
    expect(CatalogueProviderSchema.safeParse({ ...base, apiOrigins: [] }).success).toBe(false);
    expect(
      CatalogueProviderSchema.safeParse({
        ...base,
        apiOrigins: ["https://app.asana.com", "https://app.asana.com/"],
      }).success,
    ).toBe(false);
  });

  // The display-name rule is restated here rather than shared with the editable
  // base (apiOrigins is the shared one) — this test is what holds the two
  // declarations in step. A blank name is a dead row in the SPA's provider
  // list; an over-long one is the same admin-input boundary the row enforces.
  it("refuses a blank or over-long display name, matching the row's rule", () => {
    const base = {
      ref: "asana",
      kind: "rest-delegated" as const,
      apiOrigins: ["https://app.asana.com"],
      env: "prod" as const,
    };
    expect(CatalogueProviderSchema.safeParse({ ...base, displayName: "" }).success).toBe(false);
    expect(
      CatalogueProviderSchema.safeParse({ ...base, displayName: "x".repeat(201) }).success,
    ).toBe(false);
  });
});

describe("SENSITIVE_PROVIDER_FIELDS", () => {
  // Criterion 6, stated once: client identity, endpoints, destinations,
  // permissions, and placement are sensitive; display name and secret rotation
  // are not. Both halves are pinned — the positive list and the exclusions.
  it("is exactly the six sensitive fields", () => {
    expect([...SENSITIVE_PROVIDER_FIELDS].sort()).toEqual([
      "apiOrigins",
      "authorizeEndpoint",
      "clientId",
      "requestedScopes",
      "tokenEndpoint",
      "tokenPlacement",
    ]);
    expect(SENSITIVE_PROVIDER_FIELDS).not.toContain("displayName");
    expect(SENSITIVE_PROVIDER_FIELDS).not.toContain("clientSecret");
  });

  it("names fields the update request actually carries", () => {
    const updateKeys = Object.keys(
      ProviderUpdateRequestSchema.parse({
        displayName: "Asana",
        authorizeEndpoint: ROW.authorizeEndpoint,
        tokenEndpoint: ROW.tokenEndpoint,
        requestedScopes: [],
        apiOrigins: ROW.apiOrigins,
        tokenPlacement: { kind: "header-bearer" },
        clientId: "1200000000000001",
        clientSecret: "a1b2c3d4e5f6g7h8i9j0",
        revision: 1,
      }),
    );
    for (const field of SENSITIVE_PROVIDER_FIELDS) {
      expect(updateKeys, field).toContain(field);
    }
  });

  // Every field except clientId is compared old-row-against-new-request, so
  // it must exist on both sides of that comparison or the edit route is
  // asserting a change no document can express.
  it("names value-comparable fields that exist on the stored row too", () => {
    const rowKeys = Object.keys(ConnectionProviderSchema.parse(ROW));
    for (const field of SENSITIVE_PROVIDER_FIELDS) {
      if (field === "clientId") continue;
      expect(rowKeys, field).toContain(field);
    }
  });
});
