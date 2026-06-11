import { describe, expect, it } from "vitest";
import { AppManifestSchema } from "./manifest.js";
import { VisibilitySchema } from "./visibility.js";

describe("AppManifestSchema", () => {
  it("parses the §6.3 example manifest and fills capability defaults", () => {
    const parsed = AppManifestSchema.parse({
      app: "cost-explorer",
      visibility: { mode: "private" },
      capabilities: {
        llm: { models: ["gpt-5", "claude-fable-5"], tokensPerDay: 2_000_000 },
        data: { appScope: true, userScope: true },
        mcp: ["azure-billing"],
      },
    });

    expect(parsed.app).toBe("cost-explorer");
    // externalOrigins defaulted even though it was omitted.
    expect(parsed.capabilities.externalOrigins).toEqual([]);
    expect(parsed.capabilities.llm?.tokensPerDay).toBe(2_000_000);
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

  it("requires a groupId for group visibility", () => {
    expect(VisibilitySchema.safeParse({ mode: "group" }).success).toBe(false);
    expect(VisibilitySchema.safeParse({ mode: "group", groupId: "eng-team" }).success).toBe(true);
  });
});

// Small helper to keep the URL-rejection assertion readable.
function CapabilitiesParse(capabilities: unknown) {
  return AppManifestSchema.safeParse({
    app: "x",
    visibility: { mode: "private" },
    capabilities,
  });
}
