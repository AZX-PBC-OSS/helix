import { describe, expect, it } from "vitest";

import {
  ApiOriginSchema,
  ProviderExportDocumentSchema,
  ProviderRefSchema,
  ScopeTokenSchema,
} from "./providers.js";

describe("provider contract adversarial inputs", () => {
  // URL parsing removes embedded TAB/LF/CR before interpreting separators.
  // Credentials must remain forbidden when those characters split them.
  it.each(["authorizeEndpoint", "tokenEndpoint"])(
    "refuses userinfo hidden by controls between separators in exported %s",
    (field) => {
      for (const control of ["\t", "\n", "\r"]) {
        for (const separator of ["/", "\\"]) {
          const endpoint = `https:///${control}${separator}fixture-client:fixture-password@auth.vendor.example/oauth`;
          const parsedUrl = new URL(endpoint);
          expect(parsedUrl.username).toBe("fixture-client");
          expect(parsedUrl.password).toBe("fixture-password");
          expect(parsedUrl.hostname).toBe("auth.vendor.example");

          const result = ProviderExportDocumentSchema.safeParse({
            version: 1,
            provider: {
              ref: "vendor",
              displayName: "Vendor",
              authorizeEndpoint: "https://auth.vendor.example/authorize",
              tokenEndpoint: "https://auth.vendor.example/token",
              apiOrigins: ["https://api.vendor.example"],
              [field]: endpoint,
            },
          });
          expect.soft(result.success, JSON.stringify(endpoint)).toBe(false);
        }
      }
    },
  );

  // The URL parser accepts special-scheme spellings beyond scheme://host.
  // Export validation must still see the credentials those spellings carry.
  it.each(["authorizeEndpoint", "tokenEndpoint"])(
    "refuses parser-normalized userinfo in exported %s",
    (field) => {
      const endpoints = [
        "https:fixture-client:fixture-password@auth.vendor.example/oauth",
        "https:/fixture-client:fixture-password@auth.vendor.example/oauth",
        "https:///fixture-client:fixture-password@auth.vendor.example/oauth",
        "https:\\\\fixture-client:fixture-password@auth.vendor.example/oauth",
        "ht\ttps://fixture-client:fixture-password@auth.vendor.example/oauth",
        "\nhttps://fixture-client:fixture-password@auth.vendor.example/oauth",
      ];
      for (const endpoint of endpoints) {
        const parsedUrl = new URL(endpoint);
        expect(parsedUrl.username).toBe("fixture-client");
        expect(parsedUrl.password).toBe("fixture-password");
        const result = ProviderExportDocumentSchema.safeParse({
          version: 1,
          provider: {
            ref: "vendor",
            displayName: "Vendor",
            authorizeEndpoint: "https://auth.vendor.example/authorize",
            tokenEndpoint: "https://auth.vendor.example/token",
            apiOrigins: ["https://api.vendor.example"],
            [field]: endpoint,
          },
        });
        expect.soft(result.success, JSON.stringify(endpoint)).toBe(false);
      }
    },
  );

  // A malformed authority must produce a validation result, not escape the
  // boundary as a native URL exception after the first URL check rejects it.
  it.each(["https://", "https://[invalid]", "https://vendor.example:65536", "https://%zz"])(
    "returns a validation failure without throwing for malformed origin %s",
    (origin) => {
      expect(ApiOriginSchema.safeParse(origin)).toMatchObject({ success: false });
    },
  );

  it("rejects terminal line breaks in requested scope tokens", () => {
    for (const ending of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      const scope = `projects:read${ending}`;
      expect.soft(ScopeTokenSchema.safeParse(scope).success, JSON.stringify(scope)).toBe(false);
    }
  });

  it("rejects terminal line breaks in provider references", () => {
    for (const ending of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      const ref = `vendor${ending}`;
      expect.soft(ProviderRefSchema.safeParse(ref).success, JSON.stringify(ref)).toBe(false);
    }
  });

  // URL parsing removes dot segments. Validation must still reject a supplied
  // path rather than silently broadening it to the provider's whole origin.
  it.each(["/private/..", "/%2e", "/private/%2e%2e"])(
    "rejects an API destination whose path normalizes away: %s",
    (path) => {
      expect(ApiOriginSchema.safeParse(`https://api.vendor.example${path}`).success).toBe(false);
    },
  );

  // Credentials nested in URL userinfo must not bypass the export's exclusion
  // of credential fields. These are synthetic markers, not vendor credentials.
  it.each(["authorizeEndpoint", "tokenEndpoint"])(
    "refuses credential-bearing %s in an export document",
    (field) => {
      const provider = {
        ref: "vendor",
        displayName: "Vendor",
        authorizeEndpoint: "https://auth.vendor.example/authorize",
        tokenEndpoint: "https://auth.vendor.example/token",
        apiOrigins: ["https://api.vendor.example"],
        [field]: "https://fixture-client:fixture-password@auth.vendor.example/oauth",
      };
      expect(ProviderExportDocumentSchema.safeParse({ version: 1, provider }).success).toBe(false);
    },
  );
});
