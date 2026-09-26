import { describe, expect, it } from "vitest";
import {
  EXCHANGE_AUDIENCE,
  EXCHANGE_JWT_TYP,
  EXCHANGE_TTL_SECONDS,
  INTERNAL_AUDIENCE,
  INTERNAL_JWT_TYP,
  INTERNAL_TTL_SECONDS,
} from "./internalJwt.js";
import { INSTRUCTION_AUDIENCE, INSTRUCTION_JWT_TYP } from "./instruction.js";

/**
 * ADR-0003 fixes the two new internal directions into the instruction's
 * signing discipline. The audience/typ separation is a property of the
 * CONSTANTS, not of any single verifier: a collision here (two directions
 * sharing an aud or typ) would silently weaken token passthrough protection
 * for every plane at once, so it is pinned where the values live.
 */
describe("internal-JWT direction constants (ADR-0003)", () => {
  it("keeps typ and aud distinct per direction — including from the instruction seam", () => {
    const typs = [INSTRUCTION_JWT_TYP, INTERNAL_JWT_TYP, EXCHANGE_JWT_TYP];
    const auds = [INSTRUCTION_AUDIENCE, INTERNAL_AUDIENCE, EXCHANGE_AUDIENCE];
    expect(new Set(typs).size).toBe(typs.length);
    expect(new Set(auds).size).toBe(auds.length);
  });

  it("bounds both new directions to the same short TTL class as the instruction", () => {
    // "~30 s TTL" (ADR-0003): fresh enough that replay inside the TTL is the
    // only window, short enough that no long-lived credential ever exists.
    for (const ttl of [INTERNAL_TTL_SECONDS, EXCHANGE_TTL_SECONDS]) {
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    }
  });
});
