import { describe, expect, it } from "vitest";
import { CapabilityCatalogueSchema } from "./catalogue.js";

/**
 * The catalogue's jobs extension (ADR-0001): an optional block of installed
 * qualified types. The producer is the portal's catalogue route, which derives
 * it from the deployment configuration — absence is the fully-disabled state,
 * so the schema's optionality is the contract, not a gap.
 */

/** A valid catalogue body, as the portal builds it — raw input, re-parsed per test. */
function rawCatalogue(): Record<string, unknown> {
  return {
    visibility: { modes: ["internal"] },
    llm: { models: ["claude-haiku-4-5"], baselineDollarsPerDay: 50 },
    data: { provisioned: true, baselineWritesPerDay: 10_000, baselineBytesPerDay: 50_000_000 },
    fetch: {
      externalOriginsPermitted: true,
      connections: [],
      providers: [],
      baselineRequestsPerDay: 10_000,
    },
    mcp: { enforced: false },
    offline: {
      available: true,
      scopeRule: "must not be the domain root or a /_… reserved path",
    },
    deploy: { maxFileMb: 50, maxBundleMb: 250 },
    approval: {
      baselines: {
        dollarsPerDay: 50,
        writesPerDay: 10_000,
        bytesPerDay: 50_000_000,
        fetchRequestsPerDay: 10_000,
      },
      elevationTriggers: ["externalOrigins"],
    },
  };
}

describe("CapabilityCatalogueSchema — jobs extension", () => {
  it("parses without the jobs block — absence means jobs is fully disabled here", () => {
    const parsed = CapabilityCatalogueSchema.parse(rawCatalogue());
    expect(parsed.jobs).toBeUndefined();
  });

  it("carries installed qualified types with their display names", () => {
    const parsed = CapabilityCatalogueSchema.parse({
      ...rawCatalogue(),
      jobs: { types: [{ id: "jobs:fetch", displayName: "Outbound fetch job" }] },
    });
    expect(parsed.jobs?.types).toEqual([{ id: "jobs:fetch", displayName: "Outbound fetch job" }]);
  });

  it("accepts an empty types list — servers configured but all retiring", () => {
    const parsed = CapabilityCatalogueSchema.parse({ ...rawCatalogue(), jobs: { types: [] } });
    expect(parsed.jobs?.types).toEqual([]);
  });

  it("refuses a bare type id in an entry — discovery advertises qualified ids only", () => {
    expect(
      CapabilityCatalogueSchema.safeParse({
        ...rawCatalogue(),
        jobs: { types: [{ id: "fetch", displayName: "Outbound fetch job" }] },
      }).success,
    ).toBe(false);
  });

  it("refuses a budget field — the jobs catalogue carries no daily allowance", () => {
    expect(
      CapabilityCatalogueSchema.safeParse({
        ...rawCatalogue(),
        jobs: { types: [], baselineJobsPerDay: 5 },
      }).success,
    ).toBe(false);
  });
});
