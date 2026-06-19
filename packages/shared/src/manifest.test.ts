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
        data: { user: true, collections: ["contacts"] },
        mcp: ["azure-billing"],
      },
    });

    expect(parsed.app).toBe("cost-explorer");
    // externalOrigins defaulted even though it was omitted.
    expect(parsed.capabilities.externalOrigins).toEqual([]);
    expect(parsed.capabilities.llm?.tokensPerDay).toBe(2_000_000);
    // data sub-arrays default even when only some keys are given.
    expect(parsed.capabilities.data?.user).toBe(true);
    expect(parsed.capabilities.data?.collections).toEqual(["contacts"]);
    expect(parsed.capabilities.data?.sharedRead).toEqual([]);
    expect(parsed.capabilities.data?.sharedWrite).toEqual([]);
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

  it("parses the fetch capability with defaults and keyless/bound origins", () => {
    const parsed = AppManifestSchema.parse({
      app: "stars",
      visibility: { mode: "private" },
      capabilities: {
        fetch: {
          origins: [
            { origin: "https://api.github.com" },
            { origin: "https://api.stripe.com", connection: "stripe-live" },
          ],
        },
      },
    });
    expect(parsed.capabilities.fetch?.shim).toBe(false); // defaulted
    expect(parsed.capabilities.fetch?.origins).toHaveLength(2);
    expect(parsed.capabilities.fetch?.origins[1]?.connection).toBe("stripe-live");
    // externalOrigins (direct) is untouched and independent of fetch (proxy).
    expect(parsed.capabilities.externalOrigins).toEqual([]);
  });

  it("rejects a non-URL proxied origin", () => {
    const result = CapabilitiesParse({ fetch: { origins: [{ origin: "nope" }] } });
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
