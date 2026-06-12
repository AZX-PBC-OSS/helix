import { describe, expect, it } from "vitest";
import { ApiErrorSchema, CreateAppRequestSchema, UploadVersionResponseSchema } from "./api.js";

describe("CreateAppRequestSchema", () => {
  it("defaults visibility to private", () => {
    const parsed = CreateAppRequestSchema.parse({ slug: "my-app", displayName: "My App" });
    expect(parsed.visibility).toEqual({ mode: "private" });
  });

  it("rejects a non-DNS-label slug", () => {
    expect(() => CreateAppRequestSchema.parse({ slug: "Not A Slug", displayName: "x" })).toThrow();
  });
});

describe("UploadVersionResponseSchema", () => {
  it("carries the version and an empty warnings list", () => {
    const parsed = UploadVersionResponseSchema.parse({
      version: {
        id: "22222222-2222-4222-8222-222222222222",
        appId: "11111111-1111-4111-8111-111111111111",
        number: 1,
        blobPrefix: "apps/11111111-1111-4111-8111-111111111111/1/",
        status: "preview",
        createdAt: "2026-06-11T00:00:00.000Z",
      },
      warnings: [],
    });
    expect(parsed.warnings).toEqual([]);
  });
});

describe("ApiErrorSchema", () => {
  it("validates a known error envelope", () => {
    expect(
      ApiErrorSchema.parse({ error: { code: "slug_taken", message: "taken" } }).error.code,
    ).toBe("slug_taken");
  });

  it("rejects an unknown error code", () => {
    expect(() => ApiErrorSchema.parse({ error: { code: "nope", message: "x" } })).toThrow();
  });
});
