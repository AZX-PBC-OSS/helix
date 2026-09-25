import { hkdfSync } from "node:crypto";
import { jwtVerify } from "jose";
import {
  EXCHANGE_AUDIENCE,
  EXCHANGE_JWT_TYP,
  EXCHANGE_KEY_INFO,
  EXCHANGE_TTL_SECONDS,
} from "@azx-pbc/shared";

/**
 * Verify the internal service JWT the portal mints for the portal→egress seam
 * (I-02 ADR-0003): the code-exchange operation. The key is HKDF-derived from
 * `HELIX_EXCHANGE_SECRET` with the shared info string, so the portal mint side
 * (`apps/portal/src/internalJwt.ts`) and this verify side derive identically;
 * the `typ` header + domain separation keep it unredeemable as any other token
 * — including the attested instruction (`./instruction.ts`), which egress
 * verifies against a different key, `typ`, and `aud`.
 */

const ALG = "HS256";

/** Derive the symmetric exchange key — identical on the portal mint side. */
export function deriveExchangeKey(secret: Buffer): Buffer {
  if (secret.length < 32) {
    throw new Error("HELIX_EXCHANGE_SECRET must be at least 32 bytes");
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), EXCHANGE_KEY_INFO, 32));
}

/**
 * Verify signature, typ, and freshness under the shared rule (aud + typ + max
 * age, fail closed). The token is pure authorization — no payload claims to
 * parse, and any claim the minter does not write fails the verify. Returns
 * false on any failure (the caller refuses the operation) — never throws, so
 * a malformed header can't crash the handler.
 */
export async function verifyExchangeToken(
  token: string | undefined,
  key: Buffer,
  clockToleranceSec = 5,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALG],
      typ: EXCHANGE_JWT_TYP,
      // jose fails the verify if `aud` is absent or differs — closes token
      // passthrough from either the instruction seam or the edge→portal seam.
      audience: EXCHANGE_AUDIENCE,
      clockTolerance: clockToleranceSec,
      maxTokenAge: EXCHANGE_TTL_SECONDS,
    });
    // jose only enforces exp/iat when present — absence must fail closed.
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return false;
    // No unregistered claim is accepted: a future mint-side widening must roll
    // this verifier first (the ADR-0005 strict-parse discipline).
    for (const claim of Object.keys(payload)) {
      if (claim !== "aud" && claim !== "exp" && claim !== "iat") return false;
    }
    return true;
  } catch {
    return false;
  }
}
