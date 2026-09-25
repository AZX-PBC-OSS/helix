import { hkdfSync } from "node:crypto";
import { SignJWT } from "jose";
import {
  INTERNAL_AUDIENCE,
  INTERNAL_JWT_TYP,
  INTERNAL_KEY_INFO,
  INTERNAL_TTL_SECONDS,
} from "@azx-pbc/shared";

/**
 * Mint the internal service JWT the edge hands to `helix-portal` on the
 * edge→portal seam (I-02 ADR-0003): the consult, the cancel, and the
 * `/connections/*` reverse proxy each carry one, minted per call. The verify
 * side is the portal (`apps/portal/src/internalJwt.ts`) — the key derivation
 * here is identical to that side's, same HKDF info string off the shared
 * `HELIX_INTERNAL_SECRET`, so the symmetric HS256 signature checks out across
 * the process boundary. HS256 is fine: it's a shared-secret internal hop; swap
 * for EdDSA only if the two sides ever stop sharing a secret.
 *
 * The token carries no payload claims — it is pure authorization for the call,
 * and the operation's data rides the request body (whose zod contracts are the
 * consumers' tickets). Widening it is a deliberate act: the portal's verifier
 * rejects any claim it does not know.
 */

const ALG = "HS256";

/** Derive the symmetric internal key — identical on the portal verify side. */
export function deriveInternalKey(secret: Buffer): Buffer {
  if (secret.length < 32) {
    throw new Error("HELIX_INTERNAL_SECRET must be at least 32 bytes");
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INTERNAL_KEY_INFO, 32));
}

/** Sign a fresh, short-lived token for one edge→portal call. */
export async function mintInternalToken(key: Buffer): Promise<string> {
  return (
    new SignJWT({})
      .setProtectedHeader({ alg: ALG, typ: INTERNAL_JWT_TYP })
      // `aud` pins the token to the portal trust domain — no passthrough to any
      // other verifier, including the egress seams. Asserted on verify.
      .setAudience(INTERNAL_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${INTERNAL_TTL_SECONDS}s`)
      .sign(key)
  );
}
