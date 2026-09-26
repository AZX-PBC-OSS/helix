import { randomBytes } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  EXCHANGE_AUDIENCE,
  EXCHANGE_JWT_TYP,
  INSTRUCTION_AUDIENCE,
  INSTRUCTION_JWT_TYP,
  INTERNAL_AUDIENCE,
  INTERNAL_JWT_TYP,
  INTERNAL_TTL_SECONDS,
} from "@azx-pbc/shared";
import { deriveInternalKey, mintInternalToken } from "./internalJwt.js";

const SECRET = randomBytes(32);
const KEY = deriveInternalKey(SECRET);

/** Flip the first bit of the JWS payload — a different payload, same signature. */
function tamperPayload(token: string): string {
  const parts = token.split(".");
  const payload = parts[1];
  const first = payload === undefined ? undefined : Buffer.from(payload, "base64url")[0];
  if (payload === undefined || first === undefined) throw new Error("not a compact JWS");
  const flipped = Buffer.from(payload, "base64url");
  flipped[0] = first ^ 0x01;
  return `${parts[0]}.${flipped.toString("base64url")}.${parts[2]}`;
}

/**
 * The verify rule of the portal side (apps/portal/src/internalJwt.ts), replayed
 * here with plain jose so the edge's mint half is asserted against exactly what
 * the other plane accepts: aud + typ + max age, fail closed, no extra claims.
 */
async function verifyUnderPortalRule(token: string, key: Buffer): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      typ: INTERNAL_JWT_TYP,
      audience: INTERNAL_AUDIENCE,
      clockTolerance: 5,
      maxTokenAge: INTERNAL_TTL_SECONDS,
    });
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return false;
    for (const claim of Object.keys(payload)) {
      if (claim !== "aud" && claim !== "exp" && claim !== "iat") return false;
    }
    return true;
  } catch {
    return false;
  }
}

describe("deriveInternalKey", () => {
  it("rejects a secret under the 32-byte floor", () => {
    expect(() => deriveInternalKey(randomBytes(31))).toThrow(
      /HELIX_INTERNAL_SECRET must be at least 32 bytes/,
    );
  });

  it("derives deterministically from the same secret and differently from another", () => {
    const again = deriveInternalKey(SECRET);
    const other = deriveInternalKey(randomBytes(32));
    expect(again.equals(KEY)).toBe(true);
    expect(again.equals(other)).toBe(false);
  });
});

describe("mintInternalToken", () => {
  it("mints a token the portal's verify rule accepts", async () => {
    expect(await verifyUnderPortalRule(await mintInternalToken(KEY), KEY)).toBe(true);
  });

  it("fails under a different key — the bilateral secret is load-bearing", async () => {
    expect(
      await verifyUnderPortalRule(await mintInternalToken(KEY), deriveInternalKey(randomBytes(32))),
    ).toBe(false);
  });

  // ADR-0003: audience separation. The egress seams verify a different typ and
  // aud (and hold a different key) — a token minted for edge→portal must be
  // unredeemable there, and the strongest case keeps the key identical so ONLY
  // the typ/aud separation is doing the work.
  it("is unredeemable at the portal↔egress and instruction directions (typ + aud)", async () => {
    const token = await mintInternalToken(KEY);
    for (const [typ, aud] of [
      [EXCHANGE_JWT_TYP, EXCHANGE_AUDIENCE],
      [INSTRUCTION_JWT_TYP, INSTRUCTION_AUDIENCE],
    ] as const) {
      await expect(
        jwtVerify(token, KEY, { algorithms: ["HS256"], typ, audience: aud }),
      ).rejects.toThrow();
    }
  });

  it("carries the typ header and registered claims only", async () => {
    const { protectedHeader: header, payload } = await jwtVerify(await mintInternalToken(KEY), KEY);
    expect(header.typ).toBe(INTERNAL_JWT_TYP);
    expect(header.alg).toBe("HS256");
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat"]);
    expect(payload.exp).toBeLessThanOrEqual(payload.iat! + INTERNAL_TTL_SECONDS);
  });

  it("is tamper-evident — a flipped payload bit fails the signature", async () => {
    expect(await verifyUnderPortalRule(tamperPayload(await mintInternalToken(KEY)), KEY)).toBe(
      false,
    );
  });

  it("carries a fresh per-call window — iat now, exp exactly one TTL later", async () => {
    const { payload } = await jwtVerify(await mintInternalToken(KEY), KEY);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(payload.iat).toBeGreaterThanOrEqual(nowSec - 1);
    expect(payload.exp).toBe(payload.iat! + INTERNAL_TTL_SECONDS);
  });
});
