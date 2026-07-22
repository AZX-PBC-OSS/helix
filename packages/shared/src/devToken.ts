import { createHash, randomBytes } from "node:crypto";

/**
 * The dev-token credential primitive (dev-mode design §4, §10). A dev token is an
 * opaque, high-entropy bearer the portal mints for developing an app against its
 * `env=dev` partition from a foreign origin. Like the edge session token
 * (`apps/edge/src/auth/sessions.ts`), it is generated as random bytes and stored
 * **only as a SHA-256 hash** — a DB read-leak yields hashes, not usable tokens —
 * and a fast hash is appropriate because the token is high-entropy (unlike a
 * human password, which uses scrypt).
 *
 * This lives in `@azx-pbc/shared` (node-only subpath `@azx-pbc/shared/devToken`,
 * NOT the browser-facing barrel) so the two planes agree byte-for-byte: the
 * **portal** mints + hashes here, and the step-3 **dev-gateway** recomputes the
 * same hash to look the token up. One definition, no divergence.
 */

/** Identifiable prefix on the plaintext token (GitHub `ghp_`-style), for logs/leak scanners. */
export const DEV_TOKEN_PREFIX = "azxdev_";

/** A fresh opaque dev token: `azxdev_<base64url(32 random bytes)>`. Shown once, never stored. */
export function newDevToken(): string {
  return DEV_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Stored form of a dev token — SHA-256 hex over the full presented string (prefix included). */
export function hashDevToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
