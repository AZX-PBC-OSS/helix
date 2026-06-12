import { SignJWT, jwtVerify } from "jose";

/**
 * The one-time handoff token (architecture Appendix A.3): a bearer credential
 * that travels through the browser in a URL, so every property kills a
 * specific attack — signed (nobody else mints one), ~30 s TTL (leak window),
 * audience-bound to the target app's id (worthless on any other subdomain),
 * and single-use (the session row's atomic redeem burns it; sessions.ts).
 *
 * Claims are deliberately minimal — `jti` (the pending session id), `aud`
 * (the appId, not the slug: slugs could in principle be recycled, appIds
 * never are) and the validated return path. No user PII ever rides the URL.
 *
 * HS256 with an HKDF-derived key (secrets.ts): mint and verify happen in the
 * same deployment (Appendix A.2), so asymmetry buys nothing. The `typ`
 * header plus key domain-separation keep handoff and flow tokens mutually
 * unredeemable.
 */

const TYP = "helix-handoff+jwt";
const ALG = "HS256";

export interface HandoffClaims {
  /** The pending session row's id. */
  sessionId: string;
  /** The target app's id — the audience. */
  appId: string;
  /** Validated return path, covered by the signature (tamper-proof). */
  rd: string;
}

export async function mintHandoffToken(
  claims: HandoffClaims,
  key: Buffer,
  ttlSec: number,
): Promise<string> {
  return new SignJWT({ rd: claims.rd })
    .setProtectedHeader({ alg: ALG, typ: TYP })
    .setJti(claims.sessionId)
    .setAudience(claims.appId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key);
}

export interface HandoffVerifyOptions {
  ttlSec: number;
  clockToleranceSec: number;
}

/**
 * Verify signature, typ, audience and freshness; null on any failure. The
 * caller must still burn `sessionId` atomically — verification alone never
 * authenticates anyone.
 */
export async function verifyHandoffToken(
  token: string,
  expectedAppId: string,
  key: Buffer,
  opts: HandoffVerifyOptions,
): Promise<HandoffClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALG],
      typ: TYP,
      audience: expectedAppId,
      clockTolerance: opts.clockToleranceSec,
      // Also bounds `iat`: rejects both ancient tokens with a doctored exp
      // and not-yet-issued tokens from a skewed/forged mint.
      maxTokenAge: opts.ttlSec,
    });
    // jose only *enforces* exp/iat when present — absence must fail here.
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
    if (typeof payload.jti !== "string" || typeof payload.rd !== "string") return null;
    return { sessionId: payload.jti, appId: expectedAppId, rd: payload.rd };
  } catch {
    return null;
  }
}
