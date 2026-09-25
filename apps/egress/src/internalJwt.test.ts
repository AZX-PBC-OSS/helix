import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  EXCHANGE_AUDIENCE,
  EXCHANGE_JWT_TYP,
  EXCHANGE_TTL_SECONDS,
  INSTRUCTION_AUDIENCE,
  INSTRUCTION_JWT_TYP,
  INTERNAL_AUDIENCE,
  INTERNAL_JWT_TYP,
} from "@azx-pbc/shared";
import { deriveExchangeKey, verifyExchangeToken } from "./internalJwt.js";
import { deriveInstructionKey } from "./instruction.js";

const secret = randomBytes(32);
const key = deriveExchangeKey(secret);

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
 * A real mint the way the portal side writes it (apps/portal/src/internalJwt.ts
 * — same constants, same jose calls): a genuine HS256 JWT, never a hand-built
 * header. Tests here drive the egress verify half against it.
 */
async function mintExchangeToken(keyToSign: Buffer = key): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: EXCHANGE_JWT_TYP })
    .setAudience(EXCHANGE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${EXCHANGE_TTL_SECONDS}s`)
    .sign(keyToSign);
}

describe("deriveExchangeKey", () => {
  it("rejects a secret under the 32-byte floor", () => {
    expect(() => deriveExchangeKey(randomBytes(31))).toThrow(
      /HELIX_EXCHANGE_SECRET must be at least 32 bytes/,
    );
  });

  it("derives deterministically from the same secret and differently from another", () => {
    expect(deriveExchangeKey(secret).equals(key)).toBe(true);
    expect(deriveExchangeKey(randomBytes(32)).equals(key)).toBe(false);
  });
});

describe("verifyExchangeToken", () => {
  it("accepts a real exchange-direction token", async () => {
    expect(await verifyExchangeToken(await mintExchangeToken(), key)).toBe(true);
  });

  it("fails closed on a missing or empty token", async () => {
    expect(await verifyExchangeToken(undefined, key)).toBe(false);
    expect(await verifyExchangeToken("", key)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: EXCHANGE_JWT_TYP })
      .setAudience(EXCHANGE_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    expect(await verifyExchangeToken(expired, key)).toBe(false);
  });

  it("rejects a token minted past the max age even before expiry", async () => {
    // iat far back, exp still ahead: the max-age rule (not expiry) is what
    // refuses it — a mint-side bug that dropped the short TTL cannot sneak a
    // long-lived token past this verifier.
    const stale = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: EXCHANGE_JWT_TYP })
      .setAudience(EXCHANGE_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
      .sign(key);
    expect(await verifyExchangeToken(stale, key)).toBe(false);
  });

  it("rejects the wrong typ — an edge→portal token is unredeemable here", async () => {
    // Same key on purpose: only the typ/aud separation doing the work.
    const internal = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: INTERNAL_JWT_TYP })
      .setAudience(INTERNAL_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(key);
    expect(await verifyExchangeToken(internal, key)).toBe(false);
  });

  it("rejects the wrong audience", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: EXCHANGE_JWT_TYP })
      .setAudience("azx-somewhere-else")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(key);
    expect(await verifyExchangeToken(token, key)).toBe(false);
  });

  it("rejects a token signed under the instruction seam's key derivation", async () => {
    // The edge→egress instruction key exists in this process; its derived key
    // and typ/aud must not redeem an exchange token.
    const instruction = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: INSTRUCTION_JWT_TYP })
      .setAudience(INSTRUCTION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(deriveInstructionKey(secret));
    expect(await verifyExchangeToken(instruction, key)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const foreign = await mintExchangeToken(deriveExchangeKey(randomBytes(32)));
    expect(await verifyExchangeToken(foreign, key)).toBe(false);
  });

  it("rejects a tampered payload (signature check)", async () => {
    expect(await verifyExchangeToken(tamperPayload(await mintExchangeToken()), key)).toBe(false);
  });

  it("rejects an unregistered claim (fail closed on a future widening)", async () => {
    const widened = await new SignJWT({ sub: "drift" })
      .setProtectedHeader({ alg: "HS256", typ: EXCHANGE_JWT_TYP })
      .setAudience(EXCHANGE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(key);
    expect(await verifyExchangeToken(widened, key)).toBe(false);
  });
});
