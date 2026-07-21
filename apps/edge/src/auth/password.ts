import {
  type BinaryLike,
  randomBytes,
  scrypt as scryptCb,
  type ScryptOptions,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { SCRYPT_KEYLEN, SCRYPT_PARAMS } from "@azx-pbc/shared";

/**
 * Shared-password (`password` visibility) verification — the edge side. The
 * portal stores `scrypt(password, salt)` and projects the hash + salt to the
 * edge (registry projection); the edge re-derives and compares in constant
 * time. The edge never sees the cleartext or anything decryptable
 * (docs/features/authentication.md). node:crypto only — no new dependency in
 * the trusted path (project plan §6); the cost params come from `@azx-pbc/shared`
 * (already a workspace dep) so the two planes can't drift.
 */

// Explicit signature: `promisify`'s overload inference doesn't reliably pick
// scrypt's options-bearing form here, so pin it — we always pass SCRYPT_PARAMS.
const scrypt = promisify(scryptCb) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Bound concurrent scrypt derivations. At OWASP's `N=2^17` each derivation
 * holds ~128 MiB (ADR-0004 ISSUE-08); this is the unauthenticated login path,
 * and the per-IP throttle is weak (in-memory, single-replica, non-atomic —
 * issue #13), so without a cap an attacker could drive many parallel
 * derivations and OOM the stateless edge. Excess verifications queue; a slot is
 * handed straight to the next waiter on release so `active` never exceeds the
 * cap. Bounds peak KDF memory at MAX_CONCURRENT_SCRYPT × ~128 MiB.
 */
const MAX_CONCURRENT_SCRYPT = 4;
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_SCRYPT) {
    active++;
    return Promise.resolve();
  }
  // Slot is inherited on handoff from release(), so `active` already counts us.
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

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
  await acquire();
  let derived: Buffer;
  try {
    derived = (await scrypt(submitted, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)) as Buffer;
  } finally {
    release();
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
