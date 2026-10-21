import { describe, expect, it } from "vitest";
import { classifyChange } from "./approval.js";
import { deltaHelp } from "./capabilityHelp.js";

/** The jobs delta paths must resolve to the background-jobs entry, never the unknown-path fallback. */
describe("deltaHelp — jobs deltas", () => {
  it("resolves both membership directions to the background-jobs entry", () => {
    for (const path of ["jobs.types[+jobs:fetch]", "jobs.types[-jobs:fetch]"]) {
      const help = deltaHelp({ path });
      expect(help.title, path).toBe("Background jobs");
      expect(help.grants, path).not.toContain("No specific explanation");
    }
  });

  it("the tooltip's rating word matches the add's classified risk", () => {
    // The queue card badges each delta's own risk ("ELEVATED" for med) beside
    // this tooltip, and every entry's opening rating word matches the
    // classification — the copy desynchronizing from the classifier is the
    // contradiction this pins.
    const caps = { mcp: [], externalOrigins: [] };
    const add = classifyChange(caps, {
      ...caps,
      jobs: { types: ["jobs:fetch"] },
    }).baselineDeltas[0]!;
    expect(add.risk).toBe("med");
    expect(deltaHelp(add).riskWhy.startsWith("Medium")).toBe(true);
  });
});
