import { describe, expect, it } from "vitest";
import type { CapabilityCatalogue } from "@azx-pbc/shared";
import { formatCapabilities, renderCapabilities } from "./capabilities.js";

const CATALOGUE: CapabilityCatalogue = {
  visibility: { modes: ["internal", "group"] },
  llm: { models: ["claude-haiku-4-5"], baselineDollarsPerDay: 50 },
  data: { provisioned: true, baselineWritesPerDay: 10000, baselineBytesPerDay: 50000000 },
  fetch: {
    externalOriginsPermitted: true,
    connections: [{ name: "stripe-test" }],
    providers: [
      {
        ref: "acme",
        kind: "rest-delegated",
        displayName: "Acme",
        apiOrigins: ["https://api.acme.example"],
        env: "prod",
      },
    ],
    baselineRequestsPerDay: 10000,
  },
  mcp: { enforced: false },
  offline: { available: true, scopeRule: "not the domain root or a /_… path" },
  deploy: { maxFileMb: 50, maxBundleMb: 250 },
  approval: {
    baselines: {
      dollarsPerDay: 50,
      writesPerDay: 10000,
      bytesPerDay: 50000000,
      fetchRequestsPerDay: 10000,
    },
    elevationTriggers: ["fetchOrigins", "publicVisibility"],
  },
};

describe("formatCapabilities", () => {
  const text = formatCapabilities(CATALOGUE);

  it("states every manifest-relevant value", () => {
    expect(text).toContain("internal, group");
    expect(text).toContain("claude-haiku-4-5");
    expect(text).toContain("$50/day");
    expect(text).toContain("10,000 writes/day");
    expect(text).toContain("stripe-test");
    expect(text).toContain("acme (Acme, prod) → https://api.acme.example");
    expect(text).toContain("50 MB per file, 250 MB per bundle");
    expect(text).toContain("any fetch.origins entry");
  });

  it("says the dev gateway is absent rather than leaving a blank", () => {
    expect(text).toContain("Dev gateway:        not deployed");
    expect(formatCapabilities({ ...CATALOGUE, devApiBase: "https://dev.example.com" })).toContain(
      "https://dev.example.com/<slug>",
    );
  });

  it("lists the grantable job types, and tells disabled apart from none offered", () => {
    expect(text).toContain("types:            not deployed");
    expect(
      formatCapabilities({
        ...CATALOGUE,
        jobs: { types: [{ id: "jobs:fetch", displayName: "Outbound fetch job" }] },
      }),
    ).toContain("jobs:fetch (Outbound fetch job)");
    expect(formatCapabilities({ ...CATALOGUE, jobs: { types: [] } })).toContain(
      "types:            (none offered)",
    );
  });
});

describe("renderCapabilities", () => {
  it("prints raw JSON with --json", () => {
    expect(JSON.parse(renderCapabilities(CATALOGUE, { json: true }))).toEqual(CATALOGUE);
  });

  it("falls back to JSON for a shape this CLI doesn't know", () => {
    const out = renderCapabilities({ somethingNew: true }, {});
    expect(out).toContain("could not format");
    expect(out).toContain('"somethingNew": true');
  });
});
