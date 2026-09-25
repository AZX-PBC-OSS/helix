import { describe, expect, it } from "vitest";
import { AttestedInstructionSchema } from "./instruction.js";

/** A minimal valid payload — the shape the edge mints for a proxied call. */
function validInstruction(overrides: Record<string, unknown> = {}) {
  return {
    appId: "00000000-0000-4000-8000-000000000000",
    userOid: "oid-alice",
    capability: "fetch",
    origin: "https://api.github.com",
    requestId: "req-1",
    ...overrides,
  };
}

// T-0002 / ADR-0005: the attested instruction is the signed boundary between
// the policy plane and the mechanism plane, so its schema is strict — a claim
// an older egress does not know must fail the verify closed instead of being
// silently stripped (the version-skew strip would otherwise drop a credential
// field and send the call out unauthenticated).
describe("AttestedInstructionSchema (ADR-0005)", () => {
  it("parses the shape the edge mints, defaulting env to prod", () => {
    const parsed = AttestedInstructionSchema.parse(validInstruction());
    expect(parsed.env).toBe("prod");
    expect(parsed.capability).toBe("fetch");
  });

  it("rejects an unknown key today's non-strict schema would strip", () => {
    // This is the silent-strip hazard ADR-0005 exists to close: with the old
    // z.object this typo'd near-miss of a real claim parsed clean and vanished.
    const result = AttestedInstructionSchema.safeParse(validInstruction({ requestid: "req-1" }));
    expect(result.success).toBe(false);
  });

  it("carries exactly one credential source — provider XOR connection", () => {
    expect(
      AttestedInstructionSchema.safeParse(validInstruction({ provider: "asana" })).success,
    ).toBe(true);
    expect(
      AttestedInstructionSchema.safeParse(validInstruction({ connection: "gh" })).success,
    ).toBe(true);
    // Neither is a legal unbound call (llm, keyless fetch).
    expect(AttestedInstructionSchema.safeParse(validInstruction()).success).toBe(true);
    // Both is the unrepresentable state.
    expect(
      AttestedInstructionSchema.safeParse(validInstruction({ provider: "asana", connection: "gh" }))
        .success,
    ).toBe(false);
  });

  it("validates the provider reference against the shared charset", () => {
    expect(
      AttestedInstructionSchema.safeParse(validInstruction({ provider: "Asana" })).success,
    ).toBe(false);
  });

  it("rejects registered-claim lookalikes — the egress strips them before parsing", () => {
    // Registered JWT claims are the verifier's business, not this schema's; a
    // payload that still carries one after the verifier's separation is itself
    // an unknown key and fails.
    expect(AttestedInstructionSchema.safeParse(validInstruction({ exp: 9999999999 })).success).toBe(
      false,
    );
  });
});
