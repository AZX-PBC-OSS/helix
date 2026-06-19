import { hkdfSync } from "node:crypto";
import { jwtVerify } from "jose";
import {
  type AttestedInstruction,
  AttestedInstructionSchema,
  INSTRUCTION_JWT_TYP,
  INSTRUCTION_KEY_INFO,
  INSTRUCTION_TTL_SECONDS,
} from "@helix/shared";

/**
 * Verify the attested instruction the policy edge minted (secrets design §4).
 * The egress service *trusts* this signature and never re-authenticates the end
 * user — so the boundary's whole safety rests on getting this right. The key is
 * HKDF-derived from `HELIX_INSTRUCTION_SECRET` with the shared info string, so
 * the edge mint side (`apps/edge`) and this verify side derive identically; the
 * `typ` header + domain separation keep it unredeemable as any other token.
 */

const ALG = "HS256";

/** Derive the symmetric instruction key — identical on the edge mint side. */
export function deriveInstructionKey(secret: Buffer): Buffer {
  if (secret.length < 32) {
    throw new Error("HELIX_INSTRUCTION_SECRET must be at least 32 bytes");
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INSTRUCTION_KEY_INFO, 32));
}

/**
 * Verify signature, typ, and freshness, then validate the payload shape.
 * Returns null on any failure (the caller refuses the proxy call) — never
 * throws, so a malformed header can't crash the handler.
 */
export async function verifyInstruction(
  token: string,
  key: Buffer,
  clockToleranceSec = 5,
): Promise<AttestedInstruction | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALG],
      typ: INSTRUCTION_JWT_TYP,
      clockTolerance: clockToleranceSec,
      maxTokenAge: INSTRUCTION_TTL_SECONDS,
    });
    // jose only enforces exp/iat when present — absence must fail closed.
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
    const parsed = AttestedInstructionSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
