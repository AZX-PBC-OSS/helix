import { hkdfSync } from "node:crypto";
import { SignJWT } from "jose";
import {
  type AttestedInstruction,
  INSTRUCTION_AUDIENCE,
  INSTRUCTION_JWT_TYP,
  INSTRUCTION_KEY_INFO,
  INSTRUCTION_TTL_SECONDS,
} from "@azx-pbc/shared";

/**
 * Mint the attested instruction the edge hands to `azx-egress` (secrets design
 * §4). The edge is the only minter; egress verifies. The key derivation here is
 * identical to the egress verify side (`apps/egress/src/instruction.ts`) — same
 * HKDF info string off the shared `HELIX_INSTRUCTION_SECRET` — so the symmetric
 * HS256 signature checks out across the process boundary. HS256 is fine: it's a
 * shared-secret internal hop; swap for EdDSA only if the two sides ever stop
 * sharing a secret.
 */

const ALG = "HS256";

/** Derive the symmetric instruction key — identical on the egress verify side. */
export function deriveInstructionKey(secret: Buffer): Buffer {
  if (secret.length < 32) {
    throw new Error("HELIX_INSTRUCTION_SECRET must be at least 32 bytes");
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INSTRUCTION_KEY_INFO, 32));
}

/** Sign a fresh, short-lived instruction for one proxied call. */
export async function mintInstruction(claims: AttestedInstruction, key: Buffer): Promise<string> {
  return (
    new SignJWT({
      appId: claims.appId,
      userOid: claims.userOid,
      capability: claims.capability,
      origin: claims.origin,
      requestId: claims.requestId,
      env: claims.env,
      ...(claims.connection ? { connection: claims.connection } : {}),
    })
      .setProtectedHeader({ alg: ALG, typ: INSTRUCTION_JWT_TYP })
      // `jti` = the per-call requestId: egress burns it one-time so a captured
      // instruction can't be replayed inside its TTL. `aud` pins the token to the
      // egress trust domain (no passthrough). Both asserted on the verify side.
      .setJti(claims.requestId)
      .setAudience(INSTRUCTION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${INSTRUCTION_TTL_SECONDS}s`)
      .sign(key)
  );
}
