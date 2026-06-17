import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Shared-password (`password` visibility) verification — the edge side. The
 * portal stores `scrypt(password, salt)` and projects the hash + salt to the
 * edge (registry projection); the edge re-derives and compares in constant
 * time. The edge never sees the cleartext or anything decryptable
 * (docs/features/authentication.md). node:crypto only — no new dependency in
 * the trusted path (project plan §6).
 */

const scrypt = promisify(scryptCb);

/** Output length — MUST match SCRYPT_KEYLEN in apps/portal/src/access/password.ts. */
const SCRYPT_KEYLEN = 32;

/** A fresh pseudonymous principal for a password visitor: `pw_<random>`. */
export function newPasswordPrincipal(): string {
  return `pw_${randomBytes(9).toString("base64url")}`;
}

/**
 * Re-derive scrypt over `submitted` with the stored salt and compare against
 * the stored hash in constant time. Async so the (deliberately costly) KDF
 * never blocks the event loop. Returns false on any missing/malformed input —
 * fail closed.
 */
export async function verifyPassword(
  submitted: string,
  hashHex: string | null,
  saltHex: string | null,
): Promise<boolean> {
  if (!hashHex || !saltHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = (await scrypt(submitted, salt, SCRYPT_KEYLEN)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
