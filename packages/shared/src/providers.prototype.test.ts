import { describe, expect, it } from "vitest";

import { ProviderUpdateRequestSchema, type ProviderUpdateRequest } from "./providers.js";

const UPDATE = {
  displayName: "Vendor",
  authorizeEndpoint: "https://auth.vendor.example/authorize",
  tokenEndpoint: "https://auth.vendor.example/token",
  apiOrigins: ["https://api.vendor.example"],
  requestedScopes: [],
  tokenPlacement: { kind: "header-bearer" },
  revision: 1,
} satisfies ProviderUpdateRequest;

describe("provider update prototype-key attacks", () => {
  it("rejects an unknown __proto__ key even when its value is null", () => {
    // Computed keys and JSON parsing keep __proto__ as an own data property.
    // An object-literal prototype setter would test a different input.
    const body: unknown = JSON.parse(JSON.stringify({ ...UPDATE, ["__proto__"]: null }));
    expect(ProviderUpdateRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each(["clientId", "clientSecret"] as const)(
    "rejects a %s smuggled through a JSON __proto__ object",
    (field) => {
      const body: unknown = JSON.parse(
        JSON.stringify({ ...UPDATE, ["__proto__"]: { [field]: "synthetic-credential" } }),
      );

      // Neither credential was supplied at the top level. Accepting this
      // body can turn a keep-credentials edit into an identity change/rotation.
      const result = ProviderUpdateRequestSchema.safeParse(body);
      expect.soft(result).toMatchObject({ success: false });
      if (result.success) expect(result.data).not.toHaveProperty(field);
    },
  );
});
