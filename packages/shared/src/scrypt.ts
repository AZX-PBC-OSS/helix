/**
 * scrypt cost parameters for the shared-password (`password` visibility) gate.
 * The single source of truth so the portal (which hashes — apps/portal/src/
 * access/password.ts) and the edge (which verifies — apps/edge/src/auth/
 * password.ts) derive with the SAME cost: scrypt bakes the cost into the output,
 * so any drift makes verification silently fail.
 *
 * `N = 2^17` is OWASP's floor for scrypt; it replaces Node's default `2^14`,
 * which was 8× too weak (ADR-0004, ISSUE-08). Raising N has two consequences a
 * caller MUST honour, both encoded here:
 *
 *  1. **`maxmem` is mandatory.** scrypt's working set is ~`128 · N · r` bytes —
 *     128 MiB at these params — which exceeds Node's 32 MiB default `maxmem`, so
 *     every call throws `ERR_CRYPTO_INVALID_SCRYPT_PARAM` unless `maxmem` is
 *     passed. It is part of this object precisely so no call site can forget it.
 *  2. **Concurrency must be bounded on the untrusted path.** 128 MiB per
 *     derivation on the unauthenticated edge login endpoint is a memory-
 *     exhaustion amplifier (the per-IP throttle is weak — issue #13), so the
 *     edge caps concurrent derivations (see apps/edge/src/auth/password.ts).
 *
 * NB: no `node:*` import here — this module is re-exported from the barrel that
 * the browser SPA consumes (apps/portal-web). Pure numeric constants only; the
 * KDF itself is called on each server side.
 */
export const SCRYPT_PARAMS = {
  /** CPU/memory cost. OWASP floor for scrypt. */
  N: 2 ** 17,
  /** Block size. */
  r: 8,
  /** Parallelization. */
  p: 1,
  /** 192 MiB — headroom above the ~128 MiB working set at these params. */
  maxmem: 192 * 1024 * 1024,
} as const;

/**
 * scrypt output length in bytes. Both planes MUST derive with this length (a
 * length mismatch is a guaranteed verification failure). Kept beside the cost
 * params so the whole scrypt contract lives in one file.
 */
export const SCRYPT_KEYLEN = 32;
