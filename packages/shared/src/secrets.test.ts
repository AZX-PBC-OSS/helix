import { describe, expect, it } from "vitest";
import {
  InjectionRecipeSchema,
  SecretCreateRequestSchema,
  SecretMetadataSchema,
} from "./secrets.js";

describe("InjectionRecipeSchema", () => {
  it("accepts the three recipe kinds and defaults the header template", () => {
    expect(InjectionRecipeSchema.parse({ kind: "header-bearer" })).toEqual({
      kind: "header-bearer",
    });
    expect(InjectionRecipeSchema.parse({ kind: "header", name: "X-Api-Key" })).toEqual({
      kind: "header",
      name: "X-Api-Key",
      template: "{}",
    });
    expect(InjectionRecipeSchema.parse({ kind: "query", param: "api_key" })).toMatchObject({
      kind: "query",
      param: "api_key",
    });
  });

  it("rejects an unknown kind", () => {
    expect(() => InjectionRecipeSchema.parse({ kind: "basic" })).toThrow();
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
      injection: { kind: "header-bearer" },
      createdBy: "alice",
      createdAt: "2026-06-19T00:00:00.000Z",
    });
    expect(m.boundApps).toEqual([]);
    expect(m).not.toHaveProperty("value");
  });
});
