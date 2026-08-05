import { describe, expect, it } from "vitest";
import {
  INJECTION_KINDS,
  InjectionRecipeSchema,
  SecretCreateRequestSchema,
  SecretMetadataSchema,
  parseHmacCredential,
  validateMaterialForRecipe,
} from "./secrets.js";

/** A private key that is also a recognisable needle, for leak assertions. */
const PRIVATE = "ghp_LIVESECRETTOKEN_abcdefghijklmnop";
const BLOB = JSON.stringify({ credential: "pub-abc", key: PRIVATE });

describe("InjectionRecipeSchema", () => {
  it("accepts every recipe kind and defaults the header template", () => {
    expect(InjectionRecipeSchema.parse({ kind: "header-bearer" })).toEqual({
      kind: "header-bearer",
    });
    expect(InjectionRecipeSchema.parse({ kind: "header", name: "x-api-key" })).toEqual({
      kind: "header",
      name: "x-api-key",
      template: "{}",
    });
    expect(InjectionRecipeSchema.parse({ kind: "query", param: "api_key" })).toMatchObject({
      kind: "query",
      param: "api_key",
    });
    expect(
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "x-date",
        template: "Credential={credential},Signature={signature}",
      }),
    ).toEqual({
      kind: "hmac-timestamp",
      timestampHeader: "x-date",
      authHeader: "authorization",
      template: "Credential={credential},Signature={signature}",
    });
  });

  it("rejects an unknown kind", () => {
    expect(() => InjectionRecipeSchema.parse({ kind: "basic" })).toThrow();
  });

  it("stays in step with INJECTION_KINDS (which drives the UI select order)", () => {
    expect(InjectionRecipeSchema.options.map((o) => o.shape.kind.value)).toEqual([
      ...INJECTION_KINDS,
    ]);
  });

  // A stored row may predate the lowercase normalisation, and the schema re-parses
  // on every read in both the portal and egress — so reads must not fail on case.
  it("normalises header names to lowercase rather than rejecting them", () => {
    expect(InjectionRecipeSchema.parse({ kind: "header", name: "X-Api-Key" })).toMatchObject({
      name: "x-api-key",
    });
    expect(
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "X-Date",
        authHeader: "Authorization",
        template: "{signature}",
      }),
    ).toMatchObject({ timestampHeader: "x-date", authHeader: "authorization" });
  });

  // `host` is the load-bearing one: undici derives TLS SNI from it, so an
  // author-chosen value would move cert validation off the allowlisted origin.
  it.each(["host", "content-length", "transfer-encoding", "x-helix-method"])(
    "refuses to write the reserved header %s",
    (name) => {
      expect(() => InjectionRecipeSchema.parse({ kind: "header", name })).toThrow();
      expect(() =>
        InjectionRecipeSchema.parse({
          kind: "hmac-timestamp",
          timestampHeader: name,
          template: "{signature}",
        }),
      ).toThrow();
    },
  );

  it("rejects a header name that is not an RFC 7230 token", () => {
    expect(() => InjectionRecipeSchema.parse({ kind: "header", name: "x api key" })).toThrow();
    expect(() => InjectionRecipeSchema.parse({ kind: "header", name: "x-api-key:" })).toThrow();
  });

  it("rejects a template missing {signature} — an unsigned header would 401 forever", () => {
    expect(() =>
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "x-date",
        template: "Credential={credential}",
      }),
    ).toThrow();
  });

  // undici rejects CR/LF in header values at Request construction, so this is an
  // availability fix, not a smuggling one — but a 400 at write time beats a 502 later.
  it("rejects a template carrying CR/LF", () => {
    expect(() =>
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "x-date",
        template: "Signature={signature}\r\nX-Evil: 1",
      }),
    ).toThrow();
  });
});

describe("parseHmacCredential", () => {
  it("accepts a well-formed blob", () => {
    expect(parseHmacCredential(BLOB)).toEqual({ credential: "pub-abc", key: PRIVATE });
  });

  it.each([
    ["not json at all", PRIVATE],
    ["an empty object", "{}"],
    ["a missing key half", JSON.stringify({ credential: "pub" })],
    ["a missing credential half", JSON.stringify({ key: "priv" })],
    ["an empty half", JSON.stringify({ credential: "pub", key: "" })],
    ["a JSON array", "[]"],
  ])("rejects %s", (_label, value) => {
    expect(() => parseHmacCredential(value)).toThrow();
  });

  // V8 embeds a ~10-char prefix of its input in JSON.parse errors. That input is a
  // private key here, and the message reaches both a log sink and (absent the
  // proxy's guard) an untrusted app — so it must carry nothing from the input.
  it("throws a message containing no fragment of the input", () => {
    let message = "";
    try {
      parseHmacCredential(PRIVATE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(PRIVATE.slice(0, 6));
    // The exact V8 snippet shape, pinned explicitly.
    expect(message).not.toContain("ghp_LIVESE");
  });
});

describe("validateMaterialForRecipe", () => {
  it("requires a blob for hmac-timestamp", () => {
    const recipe = InjectionRecipeSchema.parse({
      kind: "hmac-timestamp",
      timestampHeader: "x-date",
      template: "{signature}",
    });
    expect(() => validateMaterialForRecipe(recipe, BLOB)).not.toThrow();
    expect(() => validateMaterialForRecipe(recipe, PRIVATE)).toThrow();
  });

  // The quiet, dangerous direction: a static recipe presents the material
  // verbatim, so a blob would send the PRIVATE half to the vendor in cleartext.
  it.each(["header-bearer", "header", "query"])(
    "refuses an hmac blob stored under a %s recipe",
    (kind) => {
      const recipe = InjectionRecipeSchema.parse(
        kind === "header"
          ? { kind, name: "x-api-key" }
          : kind === "query"
            ? { kind, param: "api_key" }
            : { kind },
      );
      expect(() => validateMaterialForRecipe(recipe, BLOB)).toThrow();
      expect(() => validateMaterialForRecipe(recipe, "sk_live_plain_token")).not.toThrow();
    },
  );

  // Recipe-scoped, not a new global constraint on `value`: unrelated JSON is fine.
  it("leaves JSON that is not a credential blob alone", () => {
    expect(() =>
      validateMaterialForRecipe({ kind: "header-bearer" }, JSON.stringify({ note: "hi" })),
    ).not.toThrow();
  });
});

describe("SecretCreateRequestSchema", () => {
  it("requires a value and a kebab name, defaulting the recipe to header-bearer", () => {
    const r = SecretCreateRequestSchema.parse({ name: "stripe-live", value: "sk_test_123" });
    expect(r.injection).toEqual({ kind: "header-bearer" });
  });

  it("rejects an empty value (write-only, but never empty)", () => {
    expect(() => SecretCreateRequestSchema.parse({ name: "x", value: "" })).toThrow();
  });

  it("rejects names with illegal characters", () => {
    expect(() => SecretCreateRequestSchema.parse({ name: "Stripe Live", value: "v" })).toThrow();
  });
});

describe("SecretMetadataSchema", () => {
  it("never carries the value, and defaults boundApps", () => {
    const m = SecretMetadataSchema.parse({
      id: "sec_1",
      name: "stripe-live",
      scope: "global",
      env: "prod",
      injection: { kind: "header-bearer" },
      createdBy: "alice",
      createdAt: "2026-06-19T00:00:00.000Z",
    });
    expect(m.boundApps).toEqual([]);
    expect(m).not.toHaveProperty("value");
  });
});
