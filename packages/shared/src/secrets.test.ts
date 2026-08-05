import { describe, expect, it } from "vitest";
import {
  INJECTION_KINDS,
  type InjectionRecipe,
  InjectionRecipeSchema,
  StoredInjectionRecipeSchema,
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
        template: "C={credential},S={signature}",
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
          template: "C={credential},S={signature}",
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

  // This recipe writes exactly two headers, one of them the timestamp, so there
  // is nowhere else the public credential id could travel — omitting it means the
  // upstream can never identify the key.
  it("rejects a template missing {credential} — the upstream can't identify the key", () => {
    expect(() =>
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "x-date",
        template: "Signature={signature}",
      }),
    ).toThrow();
  });

  /**
   * Both headers are written into one record, timestamp first, so equal names
   * make the auth value overwrite the timestamp — the upstream then verifies a
   * signature over a timestamp it never received. Nothing else flags it: the
   * strip set de-dupes harmlessly and the skew warning never fires.
   */
  it("rejects timestampHeader === authHeader — the second write clobbers the first", () => {
    expect(() =>
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "x-date",
        authHeader: "x-date",
        template: "C={credential},S={signature}",
      }),
    ).toThrow();
    // The easy-to-hit shape: authHeader is defaulted, so naming the timestamp
    // header `authorization` collides without the author ever writing it twice.
    expect(() =>
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "authorization",
        template: "C={credential},S={signature}",
      }),
    ).toThrow();
    // …and the collision is on the *normalised* names, not the raw ones.
    expect(() =>
      InjectionRecipeSchema.parse({
        kind: "hmac-timestamp",
        timestampHeader: "X-Date",
        authHeader: "x-date",
        template: "C={credential},S={signature}",
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
        template: "C={credential},S={signature}\r\nX-Evil: 1",
      }),
    ).toThrow();
  });
});

/**
 * The read half of the split. These rows were legal when written, and the schema
 * re-parses on every read in both planes — so tightening the *write* schema must
 * not retroactively make them unreadable unless the violation is a security one.
 */
describe("StoredInjectionRecipeSchema", () => {
  it("accepts a legacy name the strict schema now rejects, normalised", () => {
    const legacy = { kind: "header", name: "X Api Key" };
    expect(StoredInjectionRecipeSchema.parse(legacy)).toEqual({
      kind: "header",
      name: "x api key",
      template: "{}",
    });
    // …and the two genuinely differ, so the factory can't silently collapse.
    expect(() => InjectionRecipeSchema.parse(legacy)).toThrow();
  });

  // latin-1 (\x80-\xff) is inside undici's `headerCharRegex`, so such a template
  // was legal to write AND works on the wire; strict ASCII refuses it. Over-long
  // is the same story — the 512 cap is a write-time bound, not a wire limit.
  it("accepts wire-legal templates the strict ASCII rule refuses", () => {
    for (const template of ["Token café {}", "x".repeat(600) + "{}"]) {
      expect(
        StoredInjectionRecipeSchema.parse({ kind: "header", name: "x-k", template }),
      ).toMatchObject({ template });
      expect(() =>
        InjectionRecipeSchema.parse({ kind: "header", name: "x-k", template }),
      ).toThrow();
    }
  });

  // Above \xff is outside undici's class too, so it was never wire-legal — the
  // lenient parser tracks what the transport accepts, not "anything stored".
  it("still refuses CR/LF and beyond-latin1 in a stored template", () => {
    for (const template of ["a\r\nb: c", "Token “{}”"]) {
      expect(
        StoredInjectionRecipeSchema.safeParse({ kind: "header", name: "x-k", template }).success,
      ).toBe(false);
    }
  });

  // Security constraints are identical on both sides — a stored `host` is the
  // SNI-override bug, so it must fail closed on read, not merely on write.
  it.each(["host", "Host", "host ", "content-length", "x-helix-method"])(
    "fails closed on the reserved header %s",
    (name) => {
      expect(StoredInjectionRecipeSchema.safeParse({ kind: "header", name }).success).toBe(false);
      expect(
        StoredInjectionRecipeSchema.safeParse({
          kind: "hmac-timestamp",
          timestampHeader: name,
          template: "C={credential},S={signature}",
        }).success,
      ).toBe(false);
    },
  );

  it("stays in step with INJECTION_KINDS too", () => {
    expect(StoredInjectionRecipeSchema.options.map((o) => o.shape.kind.value)).toEqual([
      ...INJECTION_KINDS,
    ]);
  });

  // Compile-time proof the two parsers infer to one type: if they diverged, this
  // assignment would fail `pnpm typecheck` rather than any assertion here.
  it("produces the same TypeScript type as the strict schema", () => {
    const r: InjectionRecipe = StoredInjectionRecipeSchema.parse({ kind: "header-bearer" });
    expect(r).toEqual({ kind: "header-bearer" });
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
      template: "C={credential},S={signature}",
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

  // A row whose stored recipe could not be read degrades to null rather than
  // failing the whole response. The SPA parses this schema too, so it has to
  // accept both that and a hygiene-violating name the strict schema refuses.
  it("carries a null injection for an unreadable stored recipe", () => {
    const base = {
      id: "sec_2",
      name: "legacy",
      scope: "global" as const,
      env: "prod" as const,
      createdBy: "alice",
      createdAt: "2026-06-19T00:00:00.000Z",
    };
    expect(SecretMetadataSchema.parse({ ...base, injection: null }).injection).toBeNull();
    expect(
      SecretMetadataSchema.parse({ ...base, injection: { kind: "header", name: "X Api Key" } })
        .injection,
    ).toMatchObject({ name: "x api key" });
  });
});
