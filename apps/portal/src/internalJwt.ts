import { hkdfSync } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import {
  EXCHANGE_AUDIENCE,
  EXCHANGE_JWT_TYP,
  EXCHANGE_KEY_INFO,
  EXCHANGE_TTL_SECONDS,
  INTERNAL_AUDIENCE,
  INTERNAL_JWT_TYP,
  INTERNAL_KEY_INFO,
  INTERNAL_TTL_SECONDS,
} from "@azx-pbc/shared";

/**
 * The portal's half of the two internal-JWT directions (I-02 ADR-0003): it
 * **verifies** the edge→portal tokens (the consult, cancel, and reverse-proxy
 * calls the edge mints — `apps/edge/src/internalJwt.ts`) and **mints** the
 * portal→egress tokens (the code-exchange operation egress verifies —
 * `apps/egress/src/internalJwt.ts`). Same signing discipline as the attested
 * instruction: HS256 via jose over a per-direction shared secret, distinct
 * `typ` + `aud` per direction, ~30 s TTL, no burn store.
 *
 * The verify rule is aud + typ + max age, fail closed, and the token is pure
 * authorization — no payload claims, and any claim the minter does not write
 * fails the verify (a future widening rolls verifiers first, never silently).
 *
 * Secrets are read through resolvers with an injectable env (the
 * `resolveAppPublicBase` pattern), never from process.env at the call site, so
 * tests can exercise the real paths against literals.
 */

const ALG = "HS256";

/**
 * The edge↔portal key (`HELIX_INTERNAL_SECRET`) — the VERIFY side here, so it
 * is required: a portal without it must not boot, because the internal routes
 * have no degraded mode that still serves them (ADR-0003: no internal route
 * accepts a call without a verified token). Missing or short is a boot error,
 * not a per-request surprise.
 */
export function resolveInternalSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.HELIX_INTERNAL_SECRET;
  if (!raw) {
    throw new Error(
      "HELIX_INTERNAL_SECRET is required (the edge↔portal internal-JWT key, ADR-0003)",
    );
  }
  const buf = Buffer.from(raw);
  if (buf.byteLength < 32) {
    throw new Error("HELIX_INTERNAL_SECRET must be at least 32 bytes");
  }
  return buf;
}

/**
 * The portal↔egress key (`HELIX_EXCHANGE_SECRET`) — the MINT side here, so it
 * is optional exactly like the edge's instruction secret: null leaves the
 * exchange delegation unwired and the consuming route refuses rather than
 * degrades. A set-but-short value is still an error (it would weaken the
 * derived key).
 */
export function resolveExchangeSecret(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.HELIX_EXCHANGE_SECRET;
  if (!raw) return null;
  const buf = Buffer.from(raw);
  if (buf.byteLength < 32) {
    throw new Error("HELIX_EXCHANGE_SECRET must be at least 32 bytes");
  }
  return buf;
}

/**
 * Fail the boot on the secret misconfigurations that would otherwise surface as
 * per-request surprises. `buildApp` calls this beside `assertDeploymentConfig`.
 */
export function assertInternalJwtSecrets(env: NodeJS.ProcessEnv = process.env): void {
  resolveInternalSecret(env);
  resolveExchangeSecret(env);
}

/** Derive the symmetric internal (edge↔portal) key — identical on the edge mint side. */
export function deriveInternalKey(secret: Buffer): Buffer {
  if (secret.length < 32) {
    throw new Error("HELIX_INTERNAL_SECRET must be at least 32 bytes");
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INTERNAL_KEY_INFO, 32));
}

/** Derive the symmetric exchange (portal↔egress) key — identical on the egress verify side. */
export function deriveExchangeKey(secret: Buffer): Buffer {
  if (secret.length < 32) {
    throw new Error("HELIX_EXCHANGE_SECRET must be at least 32 bytes");
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), EXCHANGE_KEY_INFO, 32));
}

/**
 * Verify an edge→portal token: signature, typ, and freshness under the shared
 * rule (aud + typ + max age, fail closed). Returns false on any failure (the
 * caller refuses the internal route) — never throws, so a malformed header
 * can't crash the handler.
 */
export async function verifyInternalToken(
  token: string | undefined,
  key: Buffer,
  clockToleranceSec = 5,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALG],
      typ: INTERNAL_JWT_TYP,
      // jose fails the verify if `aud` is absent or differs — closes token
      // passthrough from either the exchange seam or the instruction seam.
      audience: INTERNAL_AUDIENCE,
      clockTolerance: clockToleranceSec,
      maxTokenAge: INTERNAL_TTL_SECONDS,
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

/** Sign a fresh, short-lived token for one portal→egress exchange call. */
export async function mintExchangeToken(key: Buffer): Promise<string> {
  return (
    new SignJWT({})
      .setProtectedHeader({ alg: ALG, typ: EXCHANGE_JWT_TYP })
      // `aud` pins the token to egress's exchange trust domain — no passthrough
      // to any other verifier, including the instruction seam egress also runs.
      // Asserted on verify.
      .setAudience(EXCHANGE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${EXCHANGE_TTL_SECONDS}s`)
      .sign(key)
  );
}
