import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  EXCHANGE_AUDIENCE,
  EXCHANGE_JWT_TYP,
  EXCHANGE_TTL_SECONDS,
  INTERNAL_AUDIENCE,
  INTERNAL_JWT_TYP,
  INTERNAL_TTL_SECONDS,
} from "@azx-pbc/shared";
import {
  assertInternalJwtSecrets,
  deriveExchangeKey,
  deriveInternalKey,
  mintExchangeToken,
  resolveExchangeSecret,
  resolveInternalSecret,
  verifyInternalToken,
} from "./internalJwt.js";

const INTERNAL_SECRET = randomBytes(32);
const INTERNAL_KEY = deriveInternalKey(INTERNAL_SECRET);
const EXCHANGE_KEY = deriveExchangeKey(randomBytes(32));

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
 * A real mint the way the edge side writes it (apps/edge/src/internalJwt.ts —
 * same constants, same jose calls): a genuine HS256 JWT, never a hand-built
 * header. Tests here drive the portal verify half against it.
 */
async function mintInternalToken(keyToSign: Buffer = INTERNAL_KEY): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: INTERNAL_JWT_TYP })
    .setAudience(INTERNAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${INTERNAL_TTL_SECONDS}s`)
    .sign(keyToSign);
}

/**
 * The verify rule of the egress side (apps/egress/src/internalJwt.ts), replayed
 * here with plain jose so the portal's mint half is asserted against exactly
 * what the other plane accepts.
 */
async function verifyUnderEgressRule(token: string, key: Buffer): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      typ: EXCHANGE_JWT_TYP,
      audience: EXCHANGE_AUDIENCE,
      clockTolerance: 5,
      maxTokenAge: EXCHANGE_TTL_SECONDS,
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

describe("resolveInternalSecret / resolveExchangeSecret", () => {
  it("requires HELIX_INTERNAL_SECRET — the verify side has no degraded mode", () => {
    expect(() => resolveInternalSecret({})).toThrow(/HELIX_INTERNAL_SECRET is required/);
    expect(() => resolveInternalSecret({ HELIX_INTERNAL_SECRET: "short" })).toThrow(
      /HELIX_INTERNAL_SECRET must be at least 32 bytes/,
    );
    expect(
      resolveInternalSecret({ HELIX_INTERNAL_SECRET: "0123456789abcdef0123456789abcdef" }),
    ).toEqual(Buffer.from("0123456789abcdef0123456789abcdef"));
  });

  it("treats HELIX_EXCHANGE_SECRET as optional-but-validated — the mint side gates", () => {
    expect(resolveExchangeSecret({})).toBeNull();
    expect(() => resolveExchangeSecret({ HELIX_EXCHANGE_SECRET: "short" })).toThrow(
      /HELIX_EXCHANGE_SECRET must be at least 32 bytes/,
    );
    expect(
      resolveExchangeSecret({ HELIX_EXCHANGE_SECRET: "abcdef0123456789abcdef0123456789" }),
    ).toEqual(Buffer.from("abcdef0123456789abcdef0123456789"));
  });

  it("fails the boot on a missing verify key, and on a bad optional key", () => {
    expect(() => assertInternalJwtSecrets({})).toThrow(/HELIX_INTERNAL_SECRET is required/);
    expect(() =>
      assertInternalJwtSecrets({
        HELIX_INTERNAL_SECRET: "0123456789abcdef0123456789abcdef",
        HELIX_EXCHANGE_SECRET: "short",
      }),
    ).toThrow(/HELIX_EXCHANGE_SECRET must be at least 32 bytes/);
    expect(() =>
      assertInternalJwtSecrets({
        HELIX_INTERNAL_SECRET: "0123456789abcdef0123456789abcdef",
      }),
    ).not.toThrow();
  });
});

describe("verifyInternalToken", () => {
  it("accepts a real edge→portal token", async () => {
    expect(await verifyInternalToken(await mintInternalToken(), INTERNAL_KEY)).toBe(true);
  });

  it("fails closed on a missing or empty token", async () => {
    expect(await verifyInternalToken(undefined, INTERNAL_KEY)).toBe(false);
    expect(await verifyInternalToken("", INTERNAL_KEY)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: INTERNAL_JWT_TYP })
      .setAudience(INTERNAL_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(INTERNAL_KEY);
    expect(await verifyInternalToken(expired, INTERNAL_KEY)).toBe(false);
  });

  it("rejects the wrong typ — a portal→egress token is unredeemable here", async () => {
    // mintExchangeToken IS the wrong-direction minter: same process, same
    // discipline, different typ + aud. With the same key on purpose, so only
    // the typ/aud separation is doing the work.
    const exchange = await mintExchangeToken(INTERNAL_KEY);
    expect(await verifyInternalToken(exchange, INTERNAL_KEY)).toBe(false);
  });

  it("rejects the wrong audience", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: INTERNAL_JWT_TYP })
      .setAudience("azx-somewhere-else")
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(INTERNAL_KEY);
    expect(await verifyInternalToken(token, INTERNAL_KEY)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const foreign = await mintInternalToken(deriveInternalKey(randomBytes(32)));
    expect(await verifyInternalToken(foreign, INTERNAL_KEY)).toBe(false);
  });

  it("rejects a tampered payload (signature check)", async () => {
    expect(await verifyInternalToken(tamperPayload(await mintInternalToken()), INTERNAL_KEY)).toBe(
      false,
    );
  });

  it("rejects an unregistered claim (fail closed on a future widening)", async () => {
    const widened = await new SignJWT({ sub: "drift" })
      .setProtectedHeader({ alg: "HS256", typ: INTERNAL_JWT_TYP })
      .setAudience(INTERNAL_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(INTERNAL_KEY);
    expect(await verifyInternalToken(widened, INTERNAL_KEY)).toBe(false);
  });
});

describe("mintExchangeToken", () => {
  it("mints a token the egress verify rule accepts", async () => {
    expect(await verifyUnderEgressRule(await mintExchangeToken(EXCHANGE_KEY), EXCHANGE_KEY)).toBe(
      true,
    );
  });

  it("is unredeemable under the internal direction's typ + aud (audience separation)", async () => {
    // The reverse of the verifyInternalToken cross-direction case: an
    // exchange token presented at the edge→portal rule must fail even when the
    // key is the same.
    const token = await mintExchangeToken(INTERNAL_KEY);
    await expect(
      jwtVerify(token, INTERNAL_KEY, {
        algorithms: ["HS256"],
        typ: INTERNAL_JWT_TYP,
        audience: INTERNAL_AUDIENCE,
      }),
    ).rejects.toThrow();
  });

  it("fails under a different key — the bilateral secret is load-bearing", async () => {
    expect(
      await verifyUnderEgressRule(
        await mintExchangeToken(EXCHANGE_KEY),
        deriveExchangeKey(randomBytes(32)),
      ),
    ).toBe(false);
  });

  it("carries the typ header and registered claims only", async () => {
    const { protectedHeader: header, payload } = await jwtVerify(
      await mintExchangeToken(EXCHANGE_KEY),
      EXCHANGE_KEY,
    );
    expect(header.typ).toBe(EXCHANGE_JWT_TYP);
    expect(header.alg).toBe("HS256");
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat"]);
    expect(payload.exp).toBeLessThanOrEqual(payload.iat! + EXCHANGE_TTL_SECONDS);
  });
});
