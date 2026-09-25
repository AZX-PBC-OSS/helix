import { describe, expect, it } from "vitest";

import {
  ProviderConfigSchema,
  ProviderExportDocumentSchema,
  ProviderUpdateRequestSchema,
  type ProviderUpdateRequest,
  type TokenPlacement,
} from "./providers.js";

const CONFIG = {
  ref: "vendor",
  displayName: "Vendor",
  authorizeEndpoint: "https://auth.vendor.example/authorize",
  tokenEndpoint: "https://auth.vendor.example/token",
  apiOrigins: ["https://api.vendor.example"],
};

describe("provider contract caller misuse", () => {
  it("isolates later imports from mutations to an earlier config's defaults", () => {
    const earlier = ProviderConfigSchema.parse(CONFIG);
    const placement = { kind: "header", name: "x-user-token" } satisfies TokenPlacement;

    try {
      earlier.requestedScopes.push("admin:write");
      Object.assign(earlier.tokenPlacement, placement);

      const later = ProviderExportDocumentSchema.parse({ version: 1, provider: CONFIG });
      expect(later.provider.requestedScopes).toEqual([]);
      expect(later.provider.tokenPlacement).toEqual({ kind: "header-bearer" });
    } finally {
      // Restore even if an aliasing defect is found, so other tests stay independent.
      earlier.requestedScopes.length = 0;
      earlier.tokenPlacement.kind = "header-bearer";
      Reflect.deleteProperty(earlier.tokenPlacement, "name");
    }
  });

  it.each(["clientId", "clientSecret"] as const)(
    "does not expose an undefined %s as a supplied credential",
    (field) => {
      const body = {
        displayName: CONFIG.displayName,
        authorizeEndpoint: CONFIG.authorizeEndpoint,
        tokenEndpoint: CONFIG.tokenEndpoint,
        apiOrigins: CONFIG.apiOrigins,
        requestedScopes: [],
        tokenPlacement: { kind: "header-bearer" },
        revision: 1,
        [field]: undefined,
      } satisfies ProviderUpdateRequest;

      // Presence means identity change/rotation. A typed caller spreading an
      // optional form value must not produce that signal without a credential.
      // Either rejecting the input or removing the undefined key is safe.
      const result = ProviderUpdateRequestSchema.safeParse(body);
      expect(result.success && Object.hasOwn(result.data, field)).toBe(false);
    },
  );
});
