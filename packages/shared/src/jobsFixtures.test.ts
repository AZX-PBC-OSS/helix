import { describe, expect, it } from "vitest";
import { z } from "zod";

import { JobsProtocolV1 } from "./jobs.js";
import { JOBS_PROTOCOL_FIXTURES, runJobsProtocolFixtures } from "./jobsFixtures.js";

describe("JOBS_PROTOCOL_FIXTURES", () => {
  it("carries positive and negative examples for every contract in the aggregate", () => {
    // Two-sidedness is per contract, not aggregate: a corpus with no negative
    // example for one contract cannot distinguish a correct parser from a
    // fail-open one, and no positive example from a fail-closed one.
    for (const contract of Object.keys(JobsProtocolV1)) {
      const fixtures = JOBS_PROTOCOL_FIXTURES.filter((f) => f.contract === contract);
      expect(fixtures.length, contract).toBeGreaterThan(0);
      expect(
        fixtures.some((f) => f.valid),
        `${contract} positive`,
      ).toBe(true);
      expect(
        fixtures.some((f) => !f.valid),
        `${contract} negative`,
      ).toBe(true);
    }
  });

  it("every fixture names why it exists", () => {
    for (const fixture of JOBS_PROTOCOL_FIXTURES) {
      expect(fixture.why.length > 0, fixture.name).toBe(true);
    }
  });
});

describe("runJobsProtocolFixtures", () => {
  it("the protocol's own schemas pass the whole list", () => {
    expect(() => runJobsProtocolFixtures(JobsProtocolV1)).not.toThrow();
  });

  it("the runner fails loudly when a contract rejects a positive example", () => {
    // A contract that refuses everything stands in for a drifted schema: the
    // runner must name the failing fixture, not fail silently or skip it.
    const broken = { ...JobsProtocolV1, JobReferenceSchema: z.never() };
    expect(() => runJobsProtocolFixtures(broken)).toThrow(/opaque non-UUID job id/);
  });

  it("the runner fails loudly when a contract accepts a negative example", () => {
    // A schema that accepts anything stands in for a loosened contract: the
    // runner must report the negative fixture that slipped through.
    const broken = { ...JobsProtocolV1, FetchJobInputSchema: z.any() };
    expect(() => runJobsProtocolFixtures(broken)).toThrow(/caller-selected method/);
  });

  it("the runner still names the fixture when a parser supplies no rejection detail", () => {
    // A parser may report failure without structured detail — the seam's
    // `error` is optional. The failure must still name the fixture and say
    // that no detail was available, never crash or pass silently.
    const silent = {
      ...JobsProtocolV1,
      JobStatusSchema: { safeParse: () => ({ success: false }) },
    };
    expect(() => runJobsProtocolFixtures(silent)).toThrow(/the running status/);
    expect(() => runJobsProtocolFixtures(silent)).toThrow(/no detail/);
  });

  it("one run reports every drifted contract, not only the first", () => {
    // Fail-fast would still satisfy the two single-drift tests above; the
    // contract promises the maintainer of a drifted mirror the whole
    // mismatch list in one throw.
    const broken = { ...JobsProtocolV1, JobServerIdSchema: z.never(), JobStatusSchema: z.never() };
    let message: string | undefined;
    try {
      runJobsProtocolFixtures(broken);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, "the runner must throw on a drifted aggregate").toBeDefined();
    expect(message).toMatch(/the initial server id/);
    expect(message).toMatch(/the running status/);
  });
});
