import { describe, expect, it } from "vitest";
import { ServiceOAuthRecipeSchema, parseServiceOAuthCredential } from "./serviceOAuth.js";
import {
  InjectionRecipeSchema,
  StoredInjectionRecipeSchema,
  validateMaterialForRecipe,
  AdminSecretCreateRequestSchema,
} from "./secrets.js";

const recipe = ServiceOAuthRecipeSchema.parse({
  kind: "oauth-service-account",
  tokenEndpoint: "https://identity.example/token",
  grantType: "password",
  clientAuthentication: "none",
});
const value = JSON.stringify({
  kind: recipe.kind,
  username: "sentinel-user",
  password: "sentinel-password",
});
describe("service-account contracts", () => {
  it("supports password grants without inventing client credentials", () => {
    expect(parseServiceOAuthCredential(recipe, value).clientId).toBeUndefined();
    expect(InjectionRecipeSchema.parse(recipe)).toEqual(StoredInjectionRecipeSchema.parse(recipe));
  });
  it.each([
    "http://identity.example/token",
    "https://user:secret@identity.example/token",
    "https://identity.example/token?secret=yes",
    "https://identity.example/token#fragment",
  ])("rejects unsafe token recipient %s", (tokenEndpoint) => {
    expect(ServiceOAuthRecipeSchema.safeParse({ ...recipe, tokenEndpoint }).success).toBe(false);
  });
  it("refuses untyped parameter bags and unauthenticated client-credentials grants", () => {
    expect(
      ServiceOAuthRecipeSchema.safeParse({ ...recipe, parameters: { audience: "x" } }).success,
    ).toBe(false);
    expect(
      ServiceOAuthRecipeSchema.safeParse({ ...recipe, grantType: "client_credentials" }).success,
    ).toBe(false);
  });
  it.each(["header-bearer", "header", "query", "hmac-timestamp"])(
    "never injects acquisition credentials through %s",
    (kind) => {
      const r = InjectionRecipeSchema.parse(
        kind === "header"
          ? { kind, name: "x-key" }
          : kind === "query"
            ? { kind, param: "key" }
            : kind === "hmac-timestamp"
              ? { kind, timestampHeader: "x-date", template: "{credential}:{signature}" }
              : { kind },
      );
      expect(() => validateMaterialForRecipe(r, value)).toThrow();
    },
  );
  it("sanitizes all material parsing errors", () => {
    for (const raw of [
      "SENTINEL-PRIVATE",
      '{"password":"SENTINEL-PRIVATE"}',
      JSON.stringify({
        kind: recipe.kind,
        username: "u",
        password: "p",
        clientSecret: "SENTINEL-PRIVATE",
      }),
    ]) {
      expect(() => parseServiceOAuthCredential(recipe, raw)).toThrow(
        "service-account credential does not match its configuration",
      );
    }
  });
  it("excludes reserved platform scope", () => {
    expect(
      AdminSecretCreateRequestSchema.safeParse({
        name: "oauth",
        value,
        injection: recipe,
        scope: "platform",
      }).success,
    ).toBe(false);
  });
});
